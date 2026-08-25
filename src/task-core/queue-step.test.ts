// src/task-core/queue-step.test.ts
// 票 03 队列 step 执行单测（queue.test.ts 拆分产物）：并发上限 / 仲裁 / 迟到信号修正 /
// 信号消费（consumeSignal 窄窗）/ 终态跳过与零决策 / BE#1 并发预算 / step 顶层
// try/catch。接缝：Executor 注入 fake、TaskStore 根目录注入、时钟注入可变 clock。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue } from "./queue.ts";
import type { Executor } from "./queue.ts";
import { TaskStore } from "./store.ts";
import type { StatusSignal, TaskRecord } from "./store.ts";

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

/** readStatusSignal 可编程钩子（tripwire 受控时序：信号读取后注入外部写回完成点） */
class HookedStore extends TaskStore {
  onSignalRead: (() => void | Promise<void>) | null = null;
  override async readStatusSignal(
    taskId: string,
    opts?: { since?: number },
  ): Promise<StatusSignal | null> {
    const signal = await super.readStatusSignal(taskId, opts);
    if (this.onSignalRead !== null) await this.onSignalRead();
    return signal;
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

async function writeDone(
  root: string,
  taskId: string,
  exitCode = 0,
  sessionDir = `/sessions/${taskId}`,
): Promise<void> {
  await mkdir(join(root, "status"), { recursive: true });
  await writeFile(
    join(root, "status", `${taskId}.done`),
    JSON.stringify({ exitCode, sessionDir }),
  );
}

async function writeAborted(root: string, taskId: string): Promise<void> {
  await mkdir(join(root, "status"), { recursive: true });
  await writeFile(join(root, "status", `${taskId}.aborted`), "");
}

test("默认并发上限 3：3 个出队 spawn，第 4 个保持 queued", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    for (let i = 1; i <= 4; i++) {
      await store.writeTask(fullRecord({ taskId: `t${i}`, createdAt: t0 + i }));
    }
    const rep = await queue.step();
    assert.deepEqual(rep.decisions.map((d) => d.taskId), ["t1", "t2", "t3"]);
    assert.equal(executor.spawnCalls.map((r) => r.taskId).join(","), "t1,t2,t3");
    for (const id of ["t1", "t2", "t3"]) {
      assert.equal((await store.readTask(id))?.status, "running");
      assert.equal((await store.readTask(id))?.startedAt, t0);
    }
    assert.equal((await store.readTask("t4"))?.status, "queued");
  });
});
test("maxConcurrency 可配（=1）：同时只有一个任务出队", async () => {
  await withQueue({ maxConcurrency: 1 }, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    for (let i = 1; i <= 3; i++) {
      await store.writeTask(fullRecord({ taskId: `t${i}`, createdAt: t0 + i }));
    }
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "t1", event: "dequeue" }]);
    assert.equal(executor.spawnCalls.length, 1);
    assert.equal((await store.readTask("t2"))?.status, "queued");
    assert.equal((await store.readTask("t3"))?.status, "queued");
  });
});
test("空位释放：running 完成信号 → done 落盘 result，下一 tick 出队排队者", async () => {
  await withQueue({}, async ({ queue, store, executor, root, clock }) => {
    const t0 = clock.now;
    for (const id of ["a", "b", "c"]) {
      await store.writeTask(
        fullRecord({ taskId: id, status: "running", createdAt: t0, updatedAt: t0, timeoutSecs: 0 }),
      );
    }
    await store.writeTask(fullRecord({ taskId: "w", status: "queued", createdAt: t0 }));
    await writeDone(root, "a", 0, "/sessions/a");
    const rep1 = await queue.step();
    assert.deepEqual(rep1.decisions, [{ taskId: "a", event: "paneDone" }]);
    const done = await store.readTask("a");
    assert.equal(done?.status, "done");
    assert.equal(done?.result.sessionDir, "/sessions/a");
    assert.equal(done?.result.exitCode, 0);
    // 空位释放生效于下一 tick：本 tick 无出队
    assert.equal(executor.spawnCalls.length, 0);
    const rep2 = await queue.step();
    assert.deepEqual(rep2.decisions, [{ taskId: "w", event: "dequeue" }]);
    assert.equal(executor.spawnCalls.length, 1);
    assert.equal(executor.spawnCalls[0].taskId, "w");
    assert.equal((await store.readTask("w"))?.status, "running");
  });
});
test("仲裁：deadline 到期 + pane done 信号同 tick → pane 信号胜（done 非 timeout）", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({
        taskId: "r",
        status: "running",
        createdAt: t0 - 20_000,
        updatedAt: t0 - 11_000,
        timeoutSecs: 10,
      }),
    );
    await writeDone(root, "r", 0, "/sessions/r");
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "paneDone" }]);
    assert.equal((await store.readTask("r"))?.status, "done");
  });
});
test("仲裁：done 与 aborted 信号双发同 tick → done 胜", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({ taskId: "r", status: "running", createdAt: t0, updatedAt: t0, timeoutSecs: 0 }),
    );
    await writeDone(root, "r", 0, "/sessions/r");
    await writeAborted(root, "r");
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "paneDone" }]);
    assert.equal((await store.readTask("r"))?.status, "done");
  });
});
test("pane aborted 信号 → aborted + notifyMain（reason=aborted）", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({ taskId: "r", status: "running", createdAt: t0, updatedAt: t0, timeoutSecs: 0 }),
    );
    await writeAborted(root, "r");
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "paneAborted" }]);
    assert.deepEqual(rep.notifications, [{ taskId: "r", reason: "aborted" }]);
    assert.equal((await store.readTask("r"))?.status, "aborted");
  });
});
test("无 pane 信号 + deadline 到期 → timeout", async () => {
  await withQueue({}, async ({ queue, store, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({
        taskId: "r",
        status: "running",
        createdAt: t0 - 20_000,
        updatedAt: t0 - 11_000,
        timeoutSecs: 10,
      }),
    );
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "deadline" }]);
    assert.equal((await store.readTask("r"))?.status, "timeout");
  });
});
test("timeoutSecs=0 = 无超时语义：再老也不触发 deadline", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    await store.writeTask(
      fullRecord({ taskId: "r", status: "running", createdAt: 0, updatedAt: 0, timeoutSecs: 0 }),
    );
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, []);
    assert.equal((await store.readTask("r"))?.status, "running");
    assert.equal(executor.spawnCalls.length, 0);
    assert.equal(executor.killCalls.length, 0);
  });
});
test("迟到 done 修正：timeout + done 信号 → done（不重跑、不 retry），result 落盘", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({
        taskId: "r",
        status: "timeout",
        createdAt: t0 - 1,
        updatedAt: t0 - 1,
        attempts: 0,
        maxAttempts: 2,
        backoffSecs: [5, 30],
      }),
    );
    await writeDone(root, "r", 3, "/sessions/late");
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "paneDone" }]);
    const done = await store.readTask("r");
    assert.equal(done?.status, "done");
    assert.equal(done?.result.exitCode, 3);
    assert.equal(done?.result.sessionDir, "/sessions/late");
    assert.equal(done?.attempts, 0); // 未重试
  });
});
test("迟到 aborted 修正：timeout + aborted 信号 → aborted + notifyMain（reason=aborted）", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({
        taskId: "r",
        status: "timeout",
        createdAt: t0 - 1,
        updatedAt: t0 - 1,
        attempts: 0,
        maxAttempts: 2,
        backoffSecs: [5, 30],
      }),
    );
    await writeAborted(root, "r");
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "paneAborted" }]);
    assert.deepEqual(rep.notifications, [{ taskId: "r", reason: "aborted" }]);
    assert.equal((await store.readTask("r"))?.status, "aborted");
  });
});
test("信号消费：deadline → timeout 时删除残留信号文件（坏 done 文件不残留）", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({
        taskId: "r",
        status: "running",
        createdAt: t0 - 20_000,
        updatedAt: t0 - 11_000,
        timeoutSecs: 10,
      }),
    );
    // 坏 JSON 的 done 文件：仲裁视为无信号（不抛），但残留文件须被消费
    await mkdir(join(root, "status"), { recursive: true });
    await writeFile(join(root, "status", "r.done"), "{not json");
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "deadline" }]);
    assert.equal((await store.readTask("r"))?.status, "timeout");
    await assert.rejects(readFile(join(root, "status", "r.done"), "utf8")); // 已删除
  });
});
test("信号消费：陈旧信号（mtime < startedAt）删除——旧 attempt 残留不污染重跑", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({
        taskId: "r",
        status: "running",
        createdAt: t0 - 20_000,
        updatedAt: t0 - 11_000,
        startedAt: t0 - 10_000,
        timeoutSecs: 10,
      }),
    );
    await mkdir(join(root, "status"), { recursive: true });
    const stale = join(root, "status", "r.done");
    await writeFile(stale, JSON.stringify({ exitCode: 0, sessionDir: "/s/r" }));
    // mtime 拨到本 attempt startedAt 之前：快照按陈旧忽略，消费时同样陈旧 → 删
    const old = new Date(t0 - 70_000);
    await utimes(stale, old, old);
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "deadline" }]);
    assert.equal((await store.readTask("r"))?.status, "timeout");
    await assert.rejects(readFile(stale, "utf8")); // 陈旧已删
  });
});
test("consumeSignal 窄窗：快照读后 wrapper 新写 done（mtime ≥ startedAt）不被误删，下 tick 迟到修正", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-race-"));
  const store = new HookedStore(root);
  await mkdir(join(root, "status"), { recursive: true });
  const executor = new FakeExecutor();
  const clock = { now: 1_000_000 };
  const queue = new Queue({ store, executor, now: () => clock.now });
  const t0 = clock.now;
  await store.writeTask(
    fullRecord({
      taskId: "r",
      status: "running",
      createdAt: t0 - 20_000,
      updatedAt: t0 - 11_000,
      startedAt: t0 - 10_000,
      timeoutSecs: 10,
    }),
  );
  // 竞态注入：快照读（无信号 → deadline）之后、consumeSignal 删除之前，
  // wrapper 恰写入本 attempt 的新 done（idle 判定与 deadline 撞在同一时刻）。
  let injected = false;
  store.onSignalRead = async () => {
    if (injected) return;
    injected = true;
    await writeFile(
      join(root, "status", "r.done"),
      JSON.stringify({ exitCode: 0, sessionDir: "/s/r" }),
    );
  };
  const rep = await queue.step();
  assert.deepEqual(rep.decisions, [{ taskId: "r", event: "deadline" }]);
  assert.equal((await store.readTask("r"))?.status, "timeout");
  // 新 done 未被误删（mtime ≥ startedAt 保留，done 不丢失）
  const done = JSON.parse(await readFile(join(root, "status", "r.done"), "utf8")) as {
    exitCode: number;
  };
  assert.equal(done.exitCode, 0);
  // 下一 tick：迟到修正 timeout×paneDone → done（不重跑）
  store.onSignalRead = null;
  const rep2 = await queue.step();
  assert.deepEqual(rep2.decisions, [{ taskId: "r", event: "paneDone" }]);
  assert.equal((await store.readTask("r"))?.status, "done");
});
test("终态跳过：done/aborted/cancelled/failed(用尽) 零决策零 spawn 零 kill", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    await store.writeTask(fullRecord({ taskId: "d", status: "done", createdAt: t0, updatedAt: t0 }));
    await store.writeTask(fullRecord({ taskId: "a", status: "aborted", createdAt: t0, updatedAt: t0 }));
    await store.writeTask(fullRecord({ taskId: "c", status: "cancelled", createdAt: t0, updatedAt: t0 }));
    await store.writeTask(
      fullRecord({ taskId: "f", status: "failed", createdAt: t0, updatedAt: t0, attempts: 2, maxAttempts: 2 }),
    );
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, []);
    assert.deepEqual(rep.notifications, []);
    assert.equal(executor.spawnCalls.length, 0);
    assert.equal(executor.killCalls.length, 0);
  });
});
test("零决策：running 未到期、无信号、并发占满 → 决策空 + 磁盘不动", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    for (const id of ["a", "b", "c"]) {
      await store.writeTask(
        fullRecord({ taskId: id, status: "running", createdAt: t0, updatedAt: t0, timeoutSecs: 300 }),
      );
    }
    const rep = await queue.step();
    assert.equal(rep.now, t0);
    assert.deepEqual(rep.decisions, []);
    assert.deepEqual(rep.notifications, []);
    assert.equal(executor.spawnCalls.length, 0);
    // 无 transition → 无 writeTask → updatedAt 原样
    assert.equal((await store.readTask("a"))?.updatedAt, t0);
  });
});
test("BE#1：mini-farm 死锁解除——main 满载不占 mini 并发位，depth-2 正常出队", async () => {
  await withQueue({ owner: "mini+1", maxConcurrency: 3 }, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    // main 满载：3 个 main running（本 Queue owner 之外，不计入 mini 预算）
    for (const id of ["m1", "m2", "m3"]) {
      await store.writeTask(
        fullRecord({ taskId: id, owner: "main+0", status: "running", depth: 1, createdAt: t0, updatedAt: t0, timeoutSecs: 0 }),
      );
    }
    // mini 自己：1 个 depth-2 queued
    await store.writeTask(
      fullRecord({ taskId: "w1", owner: "mini+1", status: "queued", depth: 2, createdAt: t0, updatedAt: t0 }),
    );
    const rep = await queue.step();
    assert.deepEqual(rep.decisions.map((d) => d.taskId), ["w1"]);
    assert.deepEqual(
      executor.spawnCalls.map((r) => r.taskId),
      ["w1"],
      "freeSlots = 3 - 0 = 3：depth-2 出队（死锁解除的可观测等价）",
    );
  });
});
test("step 顶层 try/catch：executor.kill 抛错不崩 ticker（决议仍落盘、step 正常返回）", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    executor.throwOnKill = true;
    const base = fullRecord({
      taskId: "r",
      status: "timeout",
      createdAt: t0 - 1,
      updatedAt: t0 - 1,
      attempts: 0,
      maxAttempts: 2,
    });
    await store.writeTask({
      ...base,
      payload: { ...base.payload, spawn: { ...base.payload.spawn, paneId: "r-pane" } },
    });
    const rep = await queue.step(); // retry → killPane kill 抛错被顶层 catch 吸收
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "retry" }]);
    assert.equal((await store.readTask("r"))?.status, "queued");
    assert.equal((await store.readTask("r"))?.attempts, 1);
  });
});
