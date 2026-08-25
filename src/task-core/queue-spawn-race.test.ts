// src/task-core/queue-spawn-race.test.ts
// 票 03 队列 spawn 写回竞态单测（queue.test.ts 拆分产物）：spawn 挂起期间外部写
// cancelled → 写回跳过 + best-effort kill、写回失败孤儿 pane kill（用 spawn 返回值）、
// transition 落盘 merge 磁盘最新 paneId/sessionDir（快照陈旧不 clobber 写回）。
// 接缝：Executor 注入 fake + WriteBackFailingStore/HookedStore 可编程时序。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
class WriteBackFailingStore extends TaskStore {
  failNextWrite = false;
  override async writeTask(record: TaskRecord): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false; // 单发保险丝：只炸 write-back 那一次
      throw new Error("write-back failed (fake)");
    }
    return super.writeTask(record);
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

test("spawn 写回竞态：spawn 挂起期间外部写 cancelled → 写回跳过、status 保持 cancelled", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    await store.writeTask(fullRecord({ taskId: "race", createdAt: t0 }));
    executor.spawnResult = () => ({ paneId: "pane-race", sessionDir: "/sessions/race" });
    // 模拟外部写者（shutdown 双扫）：spawn 挂起期间落盘 cancelled
    executor.onSpawn = async () => {
      await store.writeTask(
        fullRecord({ taskId: "race", createdAt: t0, status: "cancelled", updatedAt: t0 + 7 }),
      );
    };
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "race", event: "dequeue" }]);
    assert.equal(executor.spawnCalls.length, 1);
    assert.deepEqual(executor.killCalls, ["pane-race"]); // skip 分支 best-effort kill（防泄漏）
    const rec = await store.readTask("race");
    assert.equal(rec?.status, "cancelled"); // 陈旧 updated 未覆盖 cancelled
    assert.equal(rec?.updatedAt, t0 + 7); // 外部写者的 updatedAt 原样保留
    assert.equal(rec?.payload.spawn.paneId, ""); // 写回被跳过（paneId 未落盘）
  });
});
test("tripwire：slow spawn 返回后外部已 cancelled → 写回复查 skip 分支必杀 pane（killCalls 含 paneId）", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    await store.writeTask(fullRecord({ taskId: "race-kill", createdAt: t0 }));
    executor.spawnResult = () => ({ paneId: "pane-race-kill", sessionDir: "/sessions/race-kill" });
    // slow spawn：挂起期间外部写者把任务写 cancelled → spawn 返回后复查见非 running
    executor.onSpawn = async () => {
      await store.writeTask(
        fullRecord({ taskId: "race-kill", createdAt: t0, status: "cancelled", updatedAt: t0 + 7 }),
      );
    };
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "race-kill", event: "dequeue" }]);
    // 此前此路径直接 return：pane 已起但 paneId 未落盘 → 探测映射缺失 → 永久泄漏；
    // 修复后 skip 分支必须镜像 catch 分支杀 pane（用 spawn 返回值，record 里没有）
    assert.deepEqual(executor.killCalls, ["pane-race-kill"]);
    // 外部写者的 cancelled 不被覆盖、写回被跳过（paneId 未落盘）
    const rec = await store.readTask("race-kill");
    assert.equal(rec?.status, "cancelled");
    assert.equal(rec?.updatedAt, t0 + 7);
    assert.equal(rec?.payload.spawn.paneId, "");
  });
});
test("写回失败 → 孤儿 pane best-effort kill：kill 带 spawn 返回 paneId；重试逻辑照常落盘", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WriteBackFailingStore(root);
  const executor = new FakeExecutor();
  const clock = { now: 1_000_000 };
  const queue = new Queue({ store, executor, now: () => clock.now });
  const t0 = clock.now;
  await store.writeTask(fullRecord({ taskId: "orphan", createdAt: t0 }));
  executor.spawnResult = () => ({ paneId: "pane-orphan", sessionDir: "/sessions/orphan" });
  executor.onSpawn = () => {
    store.failNextWrite = true; // spawn 挂起期间布防：写回那一次 writeTask 抛错
  };
  const rep = await queue.step();
  // kill 用 spawn 返回值（paneId 未落盘也能杀），不依赖 record 落盘 paneId
  assert.deepEqual(executor.killCalls, ["pane-orphan"]);
  // 写回失败不阻断重试：spawnFailed → queued + attempts=1 照常落盘
  assert.deepEqual(rep.decisions, [
    { taskId: "orphan", event: "dequeue" },
    { taskId: "orphan", event: "spawnFailed" },
  ]);
  const rec = await store.readTask("orphan");
  assert.equal(rec?.status, "queued");
  assert.equal(rec?.attempts, 1);
  assert.equal(rec?.payload.spawn.paneId, ""); // 写回未落盘
});
test("写回失败 + kill 也抛错：kill 失败不阻断重试（spawnFailed 落盘照常）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WriteBackFailingStore(root);
  const executor = new FakeExecutor();
  const clock = { now: 1_000_000 };
  const queue = new Queue({ store, executor, now: () => clock.now });
  const t0 = clock.now;
  executor.throwOnKill = true;
  await store.writeTask(fullRecord({ taskId: "orphan", createdAt: t0 }));
  executor.spawnResult = () => ({ paneId: "pane-orphan", sessionDir: "/sessions/orphan" });
  executor.onSpawn = () => {
    store.failNextWrite = true;
  };
  const rep = await queue.step();
  assert.deepEqual(executor.killCalls, ["pane-orphan"]); // kill 仍以正确 paneId 被调用（随后抛错）
  assert.deepEqual(rep.decisions, [
    { taskId: "orphan", event: "dequeue" },
    { taskId: "orphan", event: "spawnFailed" },
  ]);
  assert.equal((await store.readTask("orphan"))?.status, "queued"); // 重试未被 kill 抛错阻断
});
test("tripwire：transition 落盘 merge 磁盘最新 paneId/sessionDir（快照陈旧不 clobber 写回）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new HookedStore(root);
  const executor = new FakeExecutor();
  const clock = { now: 1_000_000 };
  const queue = new Queue({ store, executor, now: () => clock.now });
  const t0 = clock.now;
  executor.spawnResult = () => ({ paneId: "pane-trip", sessionDir: "/sessions/trip" });
  // 受控时序：spawn 挂起（writeback 不落地），直到我们放行
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  executor.onSpawn = () => gate;
  await store.writeTask(fullRecord({ taskId: "trip", createdAt: t0 }));
  const step1 = queue.step(); // 不 await：spawn 挂起，step1 悬挂（writeback 未落地）
  // 等 step1 完成 dequeue + spawn（磁盘已 running、paneId 尚未写回）
  while (executor.spawnCalls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const pre = await store.readTask("trip");
  assert.equal(pre?.status, "running");
  assert.equal(pre?.payload.spawn.paneId, ""); // 写回尚未落地（step2 快照将采集不到 paneId）
  await writeDone(root, "trip", 0, "/sessions/trip");
  // step2：快照采集于写回之前（陈旧，无 paneId）→ 信号读取后才放行 spawn 让
  // writeback 落地 → paneDone transition 落盘必须 merge 磁盘 paneId/sessionDir
  store.onSignalRead = async () => {
    release();
    await step1; // 等 writeback 完成（磁盘 paneId/sessionDir 已落盘）
  };
  const rep2 = await queue.step();
  assert.deepEqual(rep2.decisions, [{ taskId: "trip", event: "paneDone" }]);
  const final = await store.readTask("trip");
  assert.equal(final?.status, "done");
  assert.equal(final?.payload.spawn.paneId, "pane-trip"); // 修复前：被旧快照 clobber 成 ""
  assert.equal(final?.result.sessionDir, "/sessions/trip");
});
