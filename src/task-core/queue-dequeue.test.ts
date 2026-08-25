// src/task-core/queue-dequeue.test.ts
// 票 03 队列出队/spawn 载荷单测（queue.test.ts 拆分产物）：出队顺序（createdAt↑/
// taskId↑）、spawn 收完整 record、spawn 返回写回 paneId/sessionDir、
// allocateSessionDir 先落盘再 spawn、fake Executor onSpawn 可编程写信号文件。
// 接缝：Executor 注入 fake、时钟注入可变 clock。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("出队顺序：queued 候选 createdAt↑、平手 taskId↑", async () => {
  await withQueue({ maxConcurrency: 5 }, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    const plan = [
      { taskId: "c", createdAt: t0 + 3000 },
      { taskId: "a", createdAt: t0 + 1000 },
      { taskId: "e", createdAt: t0 + 2000 },
      { taskId: "d", createdAt: t0 + 2000 },
    ];
    for (const p of plan) {
      await store.writeTask(fullRecord({ taskId: p.taskId, createdAt: p.createdAt }));
    }
    await queue.step();
    assert.deepEqual(executor.spawnCalls.map((r) => r.taskId), ["a", "d", "e", "c"]);
  });
});
test("spawn 收完整 record：§13.3 全字段原样 + status=running + updatedAt=now + startedAt=now", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    const record = fullRecord({
      taskId: "full",
      createdAt: t0,
      parentId: "p1",
      depth: 1,
      type: "schedule",
      payload: {
        spawn: { form: "tui", role: "worker", prompt: "p", cwd: "/w", resumeFrom: "sess-1", paneId: "" },
        steer: { targetTaskId: "other", content: "hi" },
        msg: { targets: ["pane-1"], delivery: "directive", content: "m" },
        schedule: {
          mode: "cron",
          cron: "*/5 * * * *",
          intervalSecs: 0,
          onceAt: 0,
          lastRun: 1,
          nextRun: 300,
          firedTaskIds: ["x"],
        },
      },
      result: {
        sessionDir: "/old",
        exitCode: 3,
        cost: { model: "m", inputTokens: 1, outputTokens: 2 },
      },
    });
    await store.writeTask(record);
    await queue.step();
    assert.equal(executor.spawnCalls.length, 1);
    assert.deepEqual(executor.spawnCalls[0], {
      ...record,
      status: "running",
      updatedAt: t0,
      startedAt: t0,
    });
    // 磁盘落盘与 spawn 载荷一致（spawnResult 默认回显 paneId/sessionDir）
    assert.deepEqual(await store.readTask("full"), executor.spawnCalls[0]);
  });
});
test("spawn 返回写回：paneId 与 sessionDir 落盘（探测映射唯一落盘处）", async () => {
  await withQueue({}, async ({ queue, store, executor, clock }) => {
    const t0 = clock.now;
    executor.spawnResult = () => ({ paneId: "pane-42", sessionDir: "/sessions/t-write" });
    await store.writeTask(fullRecord({ taskId: "t-write", createdAt: t0 }));
    await queue.step();
    const rec = await store.readTask("t-write");
    assert.equal(rec?.status, "running");
    assert.equal(rec?.payload.spawn.paneId, "pane-42");
    assert.equal(rec?.result.sessionDir, "/sessions/t-write");
  });
});
test("fake Executor onSpawn 可编程写信号文件 → 下一 tick 读为 done", async () => {
  await withQueue({}, async ({ queue, store, executor, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(fullRecord({ taskId: "r", status: "queued", createdAt: t0 }));
    executor.onSpawn = async (task) => {
      await writeDone(root, task.taskId, 0, `/sessions/${task.taskId}`);
    };
    await queue.step(); // dequeue + spawn（onSpawn 写 done 信号）
    assert.equal((await store.readTask("r"))?.status, "running");
    const rep = await queue.step(); // 下一 tick 仲裁到 done
    assert.deepEqual(rep.decisions, [{ taskId: "r", event: "paneDone" }]);
    assert.equal((await store.readTask("r"))?.status, "done");
  });
});
test("allocateSessionDir 在 dequeue 时执行：sessionDir 先落盘、spawn 时刻可见；返回 paneId 写回", async () => {
  await withQueue(
    { allocateSessionDir: async (task) => `/sessions/alloc/${task.taskId}` },
    async ({ queue, store, executor, root, clock }) => {
      const t0 = clock.now;
      await store.writeTask(fullRecord({ taskId: "t-alloc", createdAt: t0 }));
      let sessionDirAtSpawn = "";
      let statusAtSpawn = "";
      executor.onSpawn = async (task) => {
        const onDisk = await store.readTask(task.taskId);
        sessionDirAtSpawn = onDisk?.result.sessionDir ?? "";
        statusAtSpawn = onDisk?.status ?? "";
      };
      executor.spawnResult = () => ({ paneId: "pane-9", sessionDir: "/sessions/alloc/t-alloc" });
      await queue.step();
      // 先落盘再 spawn：spawn 时刻磁盘已见 sessionDir 与 running
      assert.equal(sessionDirAtSpawn, "/sessions/alloc/t-alloc");
      assert.equal(statusAtSpawn, "running");
      const rec = await store.readTask("t-alloc");
      assert.equal(rec?.startedAt, t0);
      assert.equal(rec?.payload.spawn.paneId, "pane-9");
      assert.equal(rec?.result.sessionDir, "/sessions/alloc/t-alloc");
    },
  );
});
