// src/task-core/queue-usage.test.ts
// 票 03 队列 usage sidecar 单测（queue.test.ts 拆分产物）：parseUsageSidecar 纯解析 +
// Queue 读 sidecar 写 cost + BE#4 wrapper.sh 顺序断言。
// 接缝：Executor 注入 fake、TaskStore 根目录注入、时钟注入可变 clock。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Queue, parseUsageSidecar } from "./queue.ts";
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

/** 写 usage/<id>.json（模拟 wrapper 最终写 sidecar）。 */
async function writeUsage(root: string, taskId: string, sidecar: unknown): Promise<void> {
  await mkdir(join(root, "usage"), { recursive: true });
  await writeFile(join(root, "usage", `${taskId}.json`), JSON.stringify(sidecar));
}

// ---------- usage sidecar（票 06，FR7） ----------

test("parseUsageSidecar: 合法 sidecar → 解析；坏 JSON/缺字段/updatedAt 非数 → null", () => {
  assert.deepEqual(
    parseUsageSidecar('{"model":"m","inputTokens":1,"outputTokens":2,"updatedAt":3}'),
    { model: "m", inputTokens: 1, outputTokens: 2, updatedAt: 3 },
  );
  assert.equal(parseUsageSidecar("{bad"), null);
  assert.equal(parseUsageSidecar('{"model":"m","inputTokens":1,"outputTokens":2}'), null); // 缺 updatedAt
  assert.equal(parseUsageSidecar('{"model":"m","inputTokens":1,"outputTokens":2,"updatedAt":"x"}'), null); // updatedAt 非数
  assert.equal(parseUsageSidecar('{"model":7,"inputTokens":1,"outputTokens":2,"updatedAt":3}'), null); // model 非 string
});

test("Queue 读 sidecar 写 cost：done 信号 + usage sidecar → result.cost = model/inputTokens/outputTokens", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({ taskId: "u", status: "running", createdAt: t0, updatedAt: t0, timeoutSecs: 0 }),
    );
    const sessionDir = join(root, "sessions", "u");
    await writeDone(root, "u", 0, sessionDir);
    await writeUsage(root, "u", { model: "gpt-x", inputTokens: 12, outputTokens: 34, updatedAt: 999 });
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "u", event: "paneDone" }]);
    const done = await store.readTask("u");
    assert.equal(done?.status, "done");
    // updatedAt 不落入 cost（cost 只存 model/两 token 数）
    assert.deepEqual(done?.result.cost, { model: "gpt-x", inputTokens: 12, outputTokens: 34 });
  });
});

test("Queue 读 sidecar 写 cost（无 sidecar）：只写 done 不写 usage → cost 留 0", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({ taskId: "u", status: "running", createdAt: t0, updatedAt: t0, timeoutSecs: 0 }),
    );
    await writeDone(root, "u", 0, join(root, "sessions", "u"));
    await queue.step();
    const done = await store.readTask("u");
    assert.equal(done?.status, "done");
    assert.deepEqual(done?.result.cost, { model: "", inputTokens: 0, outputTokens: 0 });
  });
});

test("Queue 读 sidecar 容错：usage 文件坏 JSON → cost 留 0，不抛、不阻断 done 落盘", async () => {
  await withQueue({}, async ({ queue, store, root, clock }) => {
    const t0 = clock.now;
    await store.writeTask(
      fullRecord({ taskId: "u", status: "running", createdAt: t0, updatedAt: t0, timeoutSecs: 0 }),
    );
    await writeDone(root, "u", 0, join(root, "sessions", "u"));
    await mkdir(join(root, "usage"), { recursive: true });
    await writeFile(join(root, "usage", "u.json"), "{not json");
    const rep = await queue.step();
    assert.deepEqual(rep.decisions, [{ taskId: "u", event: "paneDone" }]);
    const done = await store.readTask("u");
    assert.equal(done?.status, "done");
    assert.deepEqual(done?.result.cost, { model: "", inputTokens: 0, outputTokens: 0 });
  });
});

test("BE#4 顺序断言：wrapper.sh 每条 done 路径 write_usage 调用先于 write_done", async () => {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const wrapper = await readFile(join(srcDir, "..", "..", "assets", "wrapper.sh"), "utf8");
  assert.ok(wrapper.includes("write_usage()"), "wrapper.sh 必须含 write_usage() 函数定义");

  const sliceBetween = (from: string, to: string): string => {
    const start = wrapper.indexOf(from);
    assert.ok(start !== -1, `未找到起点: ${from}`);
    const end = wrapper.indexOf(to, start);
    assert.ok(end !== -1, `未找到终点（自起点后）: ${to}`);
    return wrapper.slice(start, end);
  };
  const assertUsageBeforeDone = (block: string, label: string): void => {
    const usageIdx = block.indexOf("write_usage");
    const doneIdx = block.indexOf("write_done");
    assert.ok(usageIdx !== -1, `${label}: 块内必须含 write_usage 调用`);
    assert.ok(doneIdx !== -1, `${label}: 块内必须含 write_done 调用`);
    assert.ok(usageIdx < doneIdx, `${label}: write_usage 必须先于 write_done（BE#4 时序）`);
  };

  // ① worker auto_done：write_usage → pkill_headless → write_done 0 → kill_tree
  assertUsageBeforeDone(
    sliceBetween("# jsonl 判 done → 写 usage", "  else"),
    "worker auto_done",
  );
  // ② worker 非 auto_done：非 130 分支 write_usage → write_done "$code"
  assertUsageBeforeDone(
    sliceBetween("# 渲染器自行退出", "# 票 09 #5"),
    "worker 非 auto_done",
  );
  // ③ TUI auto_done：write_usage → write_done 0 → kill_tree
  assertUsageBeforeDone(
    sliceBetween("# 判 done → 写 usage", "\nelse"),
    "TUI auto_done",
  );
  // ④ TUI 非 auto_done：wait → write_usage → write_done "$?"
  assertUsageBeforeDone(
    sliceBetween("# pi 自行退出", "exit 0"),
    "TUI 非 auto_done",
  );
});
