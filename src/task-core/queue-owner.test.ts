// src/task-core/queue-owner.test.ts
// 票 03 队列 owner 过滤 / paneGone 注入 / 旧记录容错单测（queue.test.ts 拆分产物）。
// 接缝：Executor 注入 fake、TaskStore 根目录注入、时钟注入可变 clock。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/** 每个用例独立的临时根目录 + 可变时钟，结束强制清理。 */
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

/** §13.3 全字段 task record（顶层字段可覆盖；默认 queued）。 */
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

/** 写 status/<id>.done（pane 完成信号，模拟 pane 侧扩展）。 */
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

// ---------- owner 过滤（单写者三合一） ----------

test("owner 过滤：双 Queue 实例共享 store，各写各的任务，并发计数 = 本 owner running（per-farm 独立预算）", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-queue-"));
  const store = new TaskStore(root);
  const execA = new FakeExecutor();
  const execB = new FakeExecutor();
  const clock = { now: 1_000_000 };
  const qA = new Queue({ store, executor: execA, owner: "sess-a", maxConcurrency: 3, now: () => clock.now });
  const qB = new Queue({ store, executor: execB, owner: "sess-b", maxConcurrency: 3, now: () => clock.now });
  try {
    const t0 = clock.now;
    // A：3 个 queued；B：1 个 running + 1 个 queued
    for (const id of ["a1", "a2", "a3"]) {
      await store.writeTask(
        fullRecord({ taskId: id, owner: "sess-a", createdAt: t0, updatedAt: t0 }),
      );
    }
    await store.writeTask(
      fullRecord({ taskId: "b1", owner: "sess-b", status: "running", createdAt: t0, updatedAt: t0, timeoutSecs: 0 }),
    );
    await store.writeTask(
      fullRecord({ taskId: "b2", owner: "sess-b", createdAt: t0, updatedAt: t0 }),
    );
    // A 的 step：本 owner running=0（B 的 b1 不计入）→ 出满 3 个
    const repA = await qA.step();
    assert.deepEqual(repA.decisions.map((d) => d.taskId), ["a1", "a2", "a3"]);
    assert.deepEqual(execA.spawnCalls.map((r) => r.taskId), ["a1", "a2", "a3"]);
    assert.equal((await store.readTask("a3"))?.status, "running");
    // B 的记录未被 A 写（updatedAt 原样）
    assert.equal((await store.readTask("b2"))?.updatedAt, t0);
    // B 的 step：本 owner running=1（仅 b1）→ b2 出队；A 记录零写
    const repB = await qB.step();
    assert.deepEqual(repB.decisions.map((d) => d.taskId), ["b2"]);
    assert.deepEqual(execB.spawnCalls.map((r) => r.taskId), ["b2"]);
    assert.equal((await store.readTask("b2"))?.status, "running");
    assert.equal((await store.readTask("a1"))?.updatedAt, t0);
    // owner 过滤读口：store.scanTasks(owner) 分边可见
    assert.deepEqual(
      (await store.scanTasks("sess-a")).map((r) => r.taskId),
      ["a1", "a2", "a3"],
    );
    assert.deepEqual(
      (await store.scanTasks("sess-b")).map((r) => r.taskId),
      ["b1", "b2"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("存量缺 owner → 只读外务：queue 不决策不落盘，farm_status 全量仍可见", async () => {
  await withQueue({ owner: "sess-a" }, async ({ queue, store, executor, root, clock }) => {
    const t0 = clock.now;
    // 手工写一份缺 owner 的旧记录（queued）
    const legacy: Record<string, unknown> = { ...fullRecord({ taskId: "l1", createdAt: t0, updatedAt: t0 }) };
    delete legacy.owner;
    await mkdir(join(root, "tasks"), { recursive: true });
    await writeFile(join(root, "tasks", "l1.json"), JSON.stringify(legacy));
    // 本 owner 正常任务照常出队
    await store.writeTask(fullRecord({ taskId: "m1", owner: "sess-a", createdAt: t0 }));
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "m1", event: "dequeue" }]);
    // 缺 owner 记录：不迁移（仍 queued、updatedAt 原样）、不 spawn
    const l1 = await store.readTask("l1");
    assert.equal(l1?.status, "queued");
    assert.equal(l1?.updatedAt, t0);
    assert.equal(executor.spawnCalls.map((r) => r.taskId).join(","), "m1");
    // 全量扫描（farm_status/GC）仍可见
    assert.deepEqual(
      (await store.scanTasks(null)).map((r) => r.taskId),
      ["l1", "m1"],
    );
  });
});

test("owner 缺省 = M1b 兼容模式：有 owner 的记录照常读写（缺 owner 仍只读）", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    await store.writeTask(fullRecord({ taskId: "k1", createdAt: t0 }));
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "k1", event: "dequeue" }]);
    assert.equal((await store.readTask("k1"))?.status, "running");
    assert.equal(executor.spawnCalls.length, 1);
  });
});

// ---------- paneGone 注入（tick 注入 aborted） ----------

test("paneGone 注入：running 任务 pane 消失 → aborted + notifyMain；不落 status 文件", async () => {
  await withQueue({}, async ({ queue, store, executor, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({ taskId: "r", status: "running", createdAt: t0, updatedAt: t0, timeoutSecs: 0 }),
    );
    const rep = await queue.step({ paneGone: ["r"] });
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "paneAborted" }]);
    assert.deepEqual(rep.notifications, [{ taskId: "r", reason: "aborted" }]);
    assert.equal((await store.readTask("r"))?.status, "aborted");
    // 不落 status 文件：aborted 文件唯一写者 = wrapper
    await assert.rejects(readFile(join(root, "status", "r.aborted"), "utf8"));
    assert.equal(executor.spawnCalls.length, 0);
  });
});

test("paneGone guard：非 running 任务收到 paneGone 不迁移（防 IllegalTransitionError）", async () => {
  await withQueue({}, async ({ queue, store, executor, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(fullRecord({ taskId: "q", status: "queued", createdAt: t0, updatedAt: t0 }));
    await store.writeTask(fullRecord({ taskId: "d", status: "done", createdAt: t0, updatedAt: t0 }));
    const rep = await queue.step({ paneGone: ["q", "d", "nope"] });
    // q 是 queued：paneGone 不注入 aborted，照常出队（dequeue，非 paneAborted）
    assert.deepEqual(rep.decisions, [{ taskId: "q", event: "dequeue" }]);
    assert.equal((await store.readTask("q"))?.status, "running");
    assert.equal((await store.readTask("d"))?.status, "done");
    assert.equal(executor.killCalls.length, 0);
    await assert.rejects(readFile(join(root, "status", "q.aborted"), "utf8"));
    await assert.rejects(readFile(join(root, "status", "d.aborted"), "utf8"));
  });
});

test("paneGone 仲裁：done 信号与 paneGone 同 tick → pane 信号胜（done）", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({ taskId: "r", status: "running", createdAt: t0, updatedAt: t0, timeoutSecs: 0 }),
    );
    await writeDone(root, "r", 0, "/sessions/r");
    const rep = await queue.step({ paneGone: ["r"] });
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "paneDone" }]);
    assert.equal((await store.readTask("r"))?.status, "done");
    assert.deepEqual(rep.notifications, []);
  });
});

// ---------- 旧记录容错（queue 视角） ----------

test("旧记录容错：缺 startedAt/nextAttemptAt/notifiedAt/paneId 的记录照常出队，dequeue 写 startedAt", async () => {
  await withQueue({}, async ({ queue, store, executor, root, clock }) => {
    const t0 = clock.now;
    const base = fullRecord({ taskId: "old", createdAt: t0, updatedAt: t0 });
    const legacy: Record<string, unknown> = { ...base };
    delete legacy.startedAt;
    delete legacy.nextAttemptAt;
    delete legacy.notifiedAt;
    const spawn: Record<string, unknown> = { ...base.payload.spawn };
    delete spawn.paneId;
    legacy.payload = { ...base.payload, spawn };
    await mkdir(join(root, "tasks"), { recursive: true });
    await writeFile(join(root, "tasks", "old.json"), JSON.stringify(legacy));
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "old", event: "dequeue" }]);
    const rec = await store.readTask("old");
    assert.equal(rec?.status, "running");
    assert.equal(rec?.startedAt, t0);
    assert.equal(rec?.nextAttemptAt, 0);
    assert.equal(rec?.notifiedAt, 0);
    assert.equal(rec?.payload.spawn.paneId, "");
    assert.equal(executor.spawnCalls.length, 1);
  });
});
