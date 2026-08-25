// src/task-core/queue-tick.test.ts
// 票 03 队列纯决策单测（queue.test.ts 拆分产物）：tick 三阶段（pass A running 仲裁 /
// pass B 迟到修正 + retry/exhausted / pass C queued 出队）+ depth≥3 兜底守卫 +
// BE#1 freeSlots 语义 + 纯性/参数校验。tick 零 I/O，全纯。
import { test } from "node:test";
import assert from "node:assert/strict";
import { tick } from "./queue.ts";
import type { TickInput } from "./queue.ts";
import type { StatusSignal, TaskRecord } from "./store.ts";

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

test("tick 退避判据读盘：queued 且 nextAttemptAt 未到 → 不出队；到点 → 出队；缺失按 0 立即出队", () => {
  const t0 = 1_000_000;
  const base: TickInput = {
    tasks: [],
    signals: new Map(),
    paneGone: new Set(),
    now: t0,
    maxConcurrency: 3,
    runningCount: 0,
  };
  const pending = fullRecord({ taskId: "p", status: "queued", nextAttemptAt: t0 + 5_000 });
  const nowish = fullRecord({ taskId: "q", status: "queued", nextAttemptAt: 0 });
  // 未到点：零决策
  assert.deepEqual(
    tick({ ...base, tasks: [pending], now: t0 + 4_999 }).decisions,
    [],
  );
  // 到点：出队
  assert.deepEqual(
    tick({ ...base, tasks: [pending], now: t0 + 5_000 }).decisions,
    [{ taskId: "p", event: "dequeue" }],
  );
  // nextAttemptAt=0（缺省/旧记录归一化）：立即出队
  assert.deepEqual(
    tick({ ...base, tasks: [nowish], now: t0 }).decisions,
    [{ taskId: "q", event: "dequeue" }],
  );
});
test("tick 纯性：同输入两次同输出、输入不被改写", () => {
  const tasks: readonly TaskRecord[] = [
    fullRecord({ taskId: "r", status: "running", timeoutSecs: 10, updatedAt: 100 }),
  ];
  Object.freeze(tasks[0]);
  Object.freeze(tasks);
  const signals = new Map<string, StatusSignal>([
    ["r", { kind: "done", exitCode: 0, sessionDir: "/s" }],
  ]);
  const paneGone = new Set<string>(["other"]);
  const input: TickInput = { tasks, signals, paneGone, now: 200, maxConcurrency: 3, runningCount: 1 };
  Object.freeze(input);
  const before = JSON.stringify(input.tasks);
  const out1 = tick(input);
  const out2 = tick(input);
  assert.deepEqual(out1, out2);
  assert.deepEqual(out1.decisions, [{ taskId: "r", event: "paneDone" }]);
  // 每次调用返回全新 decisions 数组（无共享引用）
  assert.notEqual(out1.decisions, out2.decisions);
  assert.equal(JSON.stringify(input.tasks), before);
});
test("tick 参数校验：now/maxConcurrency/runningCount 非法 → TypeError", () => {
  const base: TickInput = {
    tasks: [],
    signals: new Map(),
    paneGone: new Set(),
    now: 1,
    maxConcurrency: 3,
    runningCount: 0,
  };
  assert.throws(() => tick({ ...base, now: Number.NaN }), TypeError);
  assert.throws(() => tick({ ...base, maxConcurrency: 0 }), TypeError);
  assert.throws(() => tick({ ...base, runningCount: -1 }), TypeError);
  assert.throws(() => tick({ ...base, runningCount: 1.5 }), TypeError);
});
test("tick depth 守卫：depth≥3 queued 不出队、不占并发位；depth=2 同快照正常出队", () => {
  const base: TickInput = {
    tasks: [],
    signals: new Map(),
    paneGone: new Set(),
    now: 1_000,
    maxConcurrency: 2,
    runningCount: 0,
  };
  const depth3 = fullRecord({ taskId: "d3", depth: 3, createdAt: 100 });
  const depth2 = fullRecord({ taskId: "d2", depth: 2, createdAt: 200 });
  const out = tick({ ...base, tasks: [depth3, depth2] });
  assert.deepEqual(
    out.decisions.map((d) => d.taskId),
    ["d2"],
    "depth≥3 无 dequeue 决策（record 停留 queued）",
  );
});
test("tick depth 守卫：maxConcurrency=1 下 gated 候选不占并发位（过滤先于占位）", () => {
  const base: TickInput = {
    tasks: [],
    signals: new Map(),
    paneGone: new Set(),
    now: 1_000,
    maxConcurrency: 1,
    runningCount: 0,
  };
  const depth3 = fullRecord({ taskId: "d3", depth: 3, createdAt: 100 });
  // 仅 depth3 候选 → 无任何 dequeue 决策（守卫拦截，而不是空占槽位后无产出）
  assert.deepEqual(
    tick({ ...base, tasks: [depth3] }).decisions.map((d) => d.taskId),
    [],
    "仅 depth3 候选 → decisions 为空",
  );
  // depth3（createdAt 更早，排序在队首）+ depth2 共存 → 仅 d2 出队：
  // 若 gated 候选先占唯一并发槽，d2 将无法出队——此断言证明过滤发生在占位之前。
  const depth2 = fullRecord({ taskId: "d2", depth: 2, createdAt: 200 });
  assert.deepEqual(
    tick({ ...base, tasks: [depth3, depth2] }).decisions.map((d) => d.taskId),
    ["d2"],
    "gated 候选不耗 maxConcurrency=1 槽位，其后 depth2 仍出队",
  );
});
test("tick depth 守卫：depth 缺失/非数（旧记录）→ 保守放行不拦", () => {
  const base: TickInput = {
    tasks: [],
    signals: new Map(),
    paneGone: new Set(),
    now: 1_000,
    maxConcurrency: 3,
    runningCount: 0,
  };
  const legacy: TaskRecord = { ...fullRecord({ taskId: "legacy" }) };
  delete (legacy as { depth?: number }).depth;
  // Number.isFinite 路径的其余两分支：NaN 与数字字符串（外部写者注入面）
  const nanDepth: TaskRecord = { ...fullRecord({ taskId: "legacy-nan" }), depth: Number.NaN };
  const strDepth = { ...fullRecord({ taskId: "legacy-str" }), depth: "2" } as unknown as TaskRecord;
  const out = tick({ ...base, tasks: [legacy, nanDepth, strDepth] });
  assert.deepEqual(
    out.decisions.map((d) => d.taskId),
    ["legacy", "legacy-nan", "legacy-str"],
    "depth 缺失/NaN/非数字符串均保守放行（存量记录不误伤）",
  );
});
test("BE#1 对照：tick 的 freeSlots 语义不变——runningCount=3 时 depth-2 不出队（修复落点在 step 的 runningCount 计算）", () => {
  const base: TickInput = {
    tasks: [],
    signals: new Map(),
    paneGone: new Set(),
    now: 1_000,
    maxConcurrency: 3,
    runningCount: 3,
  };
  const depth2 = fullRecord({ taskId: "w1", depth: 2, createdAt: 100 });
  assert.deepEqual(
    tick({ ...base, tasks: [depth2] }).decisions.map((d) => d.taskId),
    [],
    "tick 仍是 freeSlots = maxConcurrency - runningCount：修复只改 step 计算 runningCount 的口径",
  );
});
