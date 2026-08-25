// src/task-core/queue-retry.test.ts
// 票 03 队列重试/退避/用尽单测（queue.test.ts 拆分产物）：failed/timeout 重试入队
// （kill 旧 pane）、nextAttemptAt 落盘读盘（5s→30s 逐级）、进程重启退避不归零、
// 用尽 exhausted、spawnFailed（spawn 抛错回队 / 释放并发位 / allocateSessionDir
// 抛错同口径）。接缝：Executor 注入 fake、时钟注入可变 clock。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue } from "./queue.ts";
import type { Executor } from "./queue.ts";
import { TaskStore } from "./store.ts";
import type { TaskRecord } from "./store.ts";

class FakeExecutor implements Executor {
  spawnCalls: TaskRecord[] = [];
  steerCalls: { taskId: string; content: string }[] = [];
  /** kill 入参（paneId）记录 */
  killCalls: string[] = [];
  onSpawn: ((task: TaskRecord) => void | Promise<void>) | null = null;
  /** 默认回显（paneId 空、sessionDir 沿用入参）；测试可覆写模拟真实 pane */
  spawnResult: (task: TaskRecord) => { paneId: string; sessionDir: string } = (task) => ({
    paneId: "",
    sessionDir: task.result.sessionDir,
  });
  /** true → spawn 抛错（模拟 split-pane 失败） */
  throwOnSpawn = false;
  /** true → kill 抛错（模拟 cli 调用失败） */
  throwOnKill = false;

  async spawn(task: TaskRecord): Promise<{ paneId: string; sessionDir: string }> {
    this.spawnCalls.push(task);
    if (this.throwOnSpawn) throw new Error("split-pane failed");
    if (this.onSpawn !== null) await this.onSpawn(task);
    return this.spawnResult(task);
  }
  async steer(taskId: string, content: string): Promise<void> {
    this.steerCalls.push({ taskId, content });
  }
  async kill(paneId: string): Promise<void> {
    this.killCalls.push(paneId);
    if (this.throwOnKill) throw new Error("kill-pane failed");
  }
}
async function withQueue(
  overrides: {
    maxConcurrency?: number;
    owner?: string | null;
    allocateSessionDir?: (task: TaskRecord) => Promise<string>;
  } = {},
  fn: (ctx: {
    queue: Queue;
    store: TaskStore;
    executor: FakeExecutor;
    root: string;
    clock: { now: number };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-queue-"));
  const store = new TaskStore(root);
  const executor = new FakeExecutor();
  const clock = { now: 1_000_000 };
  const queue = new Queue({
    store,
    executor,
    maxConcurrency: overrides.maxConcurrency,
    owner: overrides.owner,
    allocateSessionDir: overrides.allocateSessionDir,
    now: () => clock.now,
  });
  try {
    await fn({ queue, store, executor, root, clock });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function fullRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t-default",
    type: "spawn",
    parentId: null,
    depth: 0,
    status: "queued",
    owner: "pid+start",
    createdAt: 1_000,
    updatedAt: 1_000,
    startedAt: 0,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs: 300,
    attempts: 0,
    maxAttempts: 2,
    backoffSecs: [5, 30],
    payload: {
      spawn: { form: "tui", role: "tech-director", prompt: "do it", cwd: "/tmp/p1", resumeFrom: null, paneId: "" },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: ["all"], delivery: "notice", content: "" },
      schedule: {
        mode: "once",
        cron: "",
        intervalSecs: 0,
        onceAt: 0,
        lastRun: 0,
        nextRun: 0,
        firedTaskIds: [],
      },
    },
    result: {
      sessionDir: "",
      exitCode: null,
      cost: { model: "", inputTokens: 0, outputTokens: 0 },
    },
    ...overrides,
  };
}

test("failed + attempts<maxAttempts 亦重试入队（abandon 来源的 failed），且 kill 旧 pane", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    const base = fullRecord({
      taskId: "f",
      status: "failed",
      createdAt: t0 - 1,
      updatedAt: t0 - 1,
      attempts: 0,
      maxAttempts: 2,
      backoffSecs: [5, 30],
    });
    await store.writeTask({
      ...base,
      payload: { ...base.payload, spawn: { ...base.payload.spawn, paneId: "f-pane" } },
    });
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "f", event: "retry" }]);
    assert.deepEqual(executor.killCalls, ["f-pane"]); // 重跑前 kill 旧 pane（paneId 直传）
    const rec = await store.readTask("f");
    assert.equal(rec?.status, "queued");
    assert.equal(rec?.attempts, 1);
  });
});
test("退避生效：retry 入队后未到 nextAttemptAt 不出队；到点出队；5s→30s 逐级落盘", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({
        taskId: "r",
        status: "timeout",
        createdAt: t0 - 1_000,
        updatedAt: t0 - 1_000,
        timeoutSecs: 60,
        attempts: 0,
        maxAttempts: 2,
        backoffSecs: [5, 30],
      }),
    );
    // 第一级：retry → queued attempts=1，退避 5s 落盘
    const rep1 = await queue.step();
    assert.deepEqual(rep1.decisions, [{ taskId: "r", event: "retry" }]);
    const afterR1 = await store.readTask("r");
    assert.equal(afterR1?.status, "queued");
    assert.equal(afterR1?.attempts, 1);
    assert.equal(afterR1?.nextAttemptAt, t0 + 5_000);
    // 未到点（+2s）：保持 queued，不出队
    clock.now += 2_000;
    assert.deepEqual((await queue.step()).decisions, []);
    assert.equal((await store.readTask("r"))?.status, "queued");
    assert.equal(executor.spawnCalls.length, 0);
    // 到点（+5s）：出队 spawn（attempts=1）
    clock.now += 3_000;
    assert.deepEqual((await queue.step()).decisions, [{ taskId: "r", event: "dequeue" }]);
    assert.equal(executor.spawnCalls.length, 1);
    assert.equal(executor.spawnCalls[0].attempts, 1);
    // 再失败：deadline → timeout → retry（第二级退避 30s 落盘）
    clock.now += 61_000;
    await queue.step(); // deadline
    assert.equal((await store.readTask("r"))?.status, "timeout");
    await queue.step(); // retry
    const afterR2 = await store.readTask("r");
    assert.equal(afterR2?.status, "queued");
    assert.equal(afterR2?.attempts, 2);
    assert.equal(afterR2?.nextAttemptAt, clock.now + 30_000);
    // 未到点（+29s）：保持 queued
    clock.now += 29_000;
    assert.deepEqual((await queue.step()).decisions, []);
    assert.equal(executor.spawnCalls.length, 1);
    // 到点（+30s）：出队（第二次 spawn，attempts=2）
    clock.now += 1_000;
    await queue.step();
    assert.equal(executor.spawnCalls.length, 2);
    assert.equal(executor.spawnCalls[1].attempts, 2);
    // 第三次失败 → 用尽 → failed 终态 + 通知一次
    clock.now += 61_000;
    await queue.step(); // deadline → timeout
    const repLast = await queue.step(); // exhausted
    assert.deepEqual(repLast.decisions, [{ taskId: "r", event: "exhausted" }]);
    assert.deepEqual(repLast.notifications, [{ taskId: "r", reason: "attemptsExhausted" }]);
    assert.equal((await store.readTask("r"))?.status, "failed");
    // 终态：后续 tick 零决策、零重复通知
    const repNext = await queue.step();
    assert.deepEqual(repNext.decisions, []);
    assert.deepEqual(repNext.notifications, []);
  });
});
test("进程重启（新 Queue 实例）：nextAttemptAt 落盘读盘，退避不归零", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({
        taskId: "r",
        status: "timeout",
        createdAt: t0 - 1_000,
        updatedAt: t0 - 1_000,
        timeoutSecs: 60,
        attempts: 0,
        maxAttempts: 2,
        backoffSecs: [5, 30],
      }),
    );
    // 旧实例：retry → queued，nextAttemptAt 落盘（t0+5s）
    const rep1 = await queue.step();
    assert.deepEqual(rep1.decisions, [{ taskId: "r", event: "retry" }]);
    assert.equal((await store.readTask("r"))?.status, "queued");
    // 模拟进程重启：同 store 上新建 Queue 实例
    const restarted = new Queue({ store, executor, now: () => clock.now });
    // 退避期内（+1s）：读盘判据生效，不出队（内存 backoffs 已废除）
    clock.now += 1_000;
    assert.deepEqual((await restarted.step()).decisions, []);
    assert.equal(executor.spawnCalls.length, 0);
    // 到点（+5s）：出队 spawn
    clock.now += 4_000;
    const rep2 = await restarted.step();
    assert.deepEqual(rep2.decisions, [{ taskId: "r", event: "dequeue" }]);
    assert.equal(executor.spawnCalls.length, 1);
    assert.equal(executor.spawnCalls[0].taskId, "r");
    assert.equal((await store.readTask("r"))?.status, "running");
  });
});
test("用尽：attempts=maxAttempts → exhausted → failed 终态，通知只发一次", async () => {
  await withQueue({}, async ({ queue, store, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({
        taskId: "e",
        status: "timeout",
        createdAt: t0 - 1,
        updatedAt: t0 - 1,
        attempts: 2,
        maxAttempts: 2,
      }),
    );
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "e", event: "exhausted" }]);
    assert.deepEqual(rep.notifications, [{ taskId: "e", reason: "attemptsExhausted" }]);
    assert.equal((await store.readTask("e"))?.status, "failed");
    const rep2 = await queue.step();
    assert.deepEqual(rep2.decisions, []);
    assert.deepEqual(rep2.notifications, []);
    assert.equal((await store.readTask("e"))?.status, "failed");
  });
});
test("spawnFailed：spawn 抛错 → attempts+1 回 queued、nextAttemptAt 落盘、不卡 running；退避到期后重试", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    executor.throwOnSpawn = true;
    await store.writeTask(fullRecord({ taskId: "s", createdAt: t0 }));
    const rep1 = await queue.step();
    assert.deepEqual(rep1.decisions, [
      { taskId: "s", event: "dequeue" },
      { taskId: "s", event: "spawnFailed" },
    ]);
    const rec1 = await store.readTask("s");
    assert.equal(rec1?.status, "queued"); // 不卡 running
    assert.equal(rec1?.attempts, 1);
    assert.equal(rec1?.nextAttemptAt, t0 + 5_000);
    // 退避期内不出队
    clock.now += 2_000;
    assert.deepEqual((await queue.step()).decisions, []);
    // 到点重 dequeue → 再失败 → attempts=2=max → exhausted → failed + 通知
    clock.now += 3_000;
    const rep2 = await queue.step();
    assert.deepEqual(rep2.decisions, [
      { taskId: "s", event: "dequeue" },
      { taskId: "s", event: "spawnFailed" },
    ]);
    assert.equal((await store.readTask("s"))?.attempts, 2);
    clock.now += 30_000;
    const rep3 = await queue.step();
    assert.deepEqual(rep3.decisions, [
      { taskId: "s", event: "dequeue" },
      { taskId: "s", event: "exhausted" },
    ]);
    assert.deepEqual(rep3.notifications, [{ taskId: "s", reason: "attemptsExhausted" }]);
    const final = await store.readTask("s");
    assert.equal(final?.status, "failed");
    assert.equal(final?.attempts, 2);
    // 终态：后续零决策
    assert.deepEqual((await queue.step()).decisions, []);
  });
});
test("spawnFailed 释放并发位：下一 tick 其他 queued 任务可出队", async () => {
  await withQueue({ maxConcurrency: 1 }, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    executor.throwOnSpawn = true;
    await store.writeTask(fullRecord({ taskId: "s1", createdAt: t0 }));
    await store.writeTask(fullRecord({ taskId: "s2", createdAt: t0 + 1 }));
    await queue.step(); // s1: dequeue → spawnFailed → queued（退避中）
    assert.equal((await store.readTask("s1"))?.status, "queued");
    // s1 退避中不出队；s2 无退避 → 出队（并发位未被 s1 悬空占用）；s2 spawn 同样抛错回队
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [
      { taskId: "s2", event: "dequeue" },
      { taskId: "s2", event: "spawnFailed" },
    ]);
    assert.equal(executor.spawnCalls.length, 2);
    assert.equal(executor.spawnCalls[1].taskId, "s2");
    assert.equal((await store.readTask("s1"))?.status, "queued");
    assert.equal((await store.readTask("s2"))?.status, "queued");
  });
});
test("allocateSessionDir 抛错视同 spawn 失败：回 queued 不卡 running", async () => {
  await withQueue(
    { allocateSessionDir: async () => { throw new Error("no disk"); } },
    async ({ queue, store, executor, clock }) => {
      const t0 = clock.now;
      await store.writeTask(fullRecord({ taskId: "s", createdAt: t0 }));
      const rep = await queue.step();
      assert.deepEqual(rep.decisions, [
        { taskId: "s", event: "dequeue" },
        { taskId: "s", event: "spawnFailed" },
      ]);
      const rec = await store.readTask("s");
      assert.equal(rec?.status, "queued");
      assert.equal(rec?.attempts, 1);
      assert.equal(executor.spawnCalls.length, 0); // 未实际 spawn
    },
  );
});
