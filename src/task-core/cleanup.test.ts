// src/task-core/cleanup.test.ts
// cleanup.ts 单测：真终态判定 / 通知守卫 / 选择分组 / 显示切分（6 用例）。
// 只断言外部行为（输入→输出/抛错），不窥探内部实现。
// 运行：cd src/task-core && node --test cleanup.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTrulyTerminal,
  isCleanableTerminal,
  selectTasksForCleanup,
  splitTasksForDisplay,
} from "./cleanup.ts";
import type { TaskRecord } from "./store.ts";
import type { TaskStatus } from "./states.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR; // 与 farm.ts REPLAY_WINDOW_MS 同值
const NOW = 1_700_000_000_000; // 真实 epoch ms，now - 10*MINUTE 仍为正（notifiedAt>0 判定有效）

/** 构造最小合法 TaskRecord（未覆盖字段用中性默认，覆盖项以 partial 指定）。 */
function makeTask(
  partial: Partial<TaskRecord> & Pick<TaskRecord, "taskId" | "status">,
): TaskRecord {
  return {
    type: "spawn",
    parentId: null,
    depth: 2,
    owner: "test",
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: 1000,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs: 120,
    attempts: 0,
    maxAttempts: 3,
    backoffSecs: [],
    payload: {
      spawn: { role: "worker", prompt: "p", cwd: "/tmp", resumeFrom: null, paneId: "" },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: [], delivery: "notice", content: "" },
      schedule: { mode: "once", cron: "", intervalSecs: 0, onceAt: 0, lastRun: 0, nextRun: 0, firedTaskIds: [] },
    },
    result: {
      sessionDir: "",
      exitCode: null,
      cost: { model: "m", inputTokens: 0, outputTokens: 0 },
    },
    ...partial,
  };
}

test("U1 done 封闭态 = 真终态（与 attempts 无关）；未通知不可清 → skipped.unnotified；白名单缺省含 aborted（D-B）", () => {
  const now = NOW;
  // done + attempts 未跑完（0<3）：封闭态零出边（states.ts:79），真终态与 attempts 无关
  const task = makeTask({
    taskId: "t-done",
    status: "done",
    attempts: 0,
    maxAttempts: 3,
    notifiedAt: 0,
    updatedAt: now - 10 * MINUTE,
  });
  assert.equal(isTrulyTerminal(task), true);
  // 未通知且 10min < 24h → 守卫不过
  assert.equal(isCleanableTerminal(task, now, DAY), false);

  const input = [task];
  const sel = selectTasksForCleanup(input, now, { replayWindowMs: DAY });
  assert.deepEqual(sel.skipped.unnotified, [task]);
  assert.deepEqual(sel.deletable, []);
  assert.deepEqual(sel.skipped.active, []);
  assert.deepEqual(sel.skipped.retryable, []);
  assert.deepEqual(input, [task]); // 纯性：入参数组未被修改

  // D-B：statuses 缺省 = 真终态四态（含 aborted）；显式 {done,cancelled,failed} 排除 aborted（不入任何组）
  const aborted = makeTask({
    taskId: "t-ab",
    status: "aborted",
    notifiedAt: now - MINUTE,
    updatedAt: now - MINUTE,
  });
  const byDefault = selectTasksForCleanup([aborted], now, { replayWindowMs: DAY });
  assert.deepEqual(byDefault.deletable, [aborted]);
  const excluded = selectTasksForCleanup([aborted], now, {
    replayWindowMs: DAY,
    statuses: new Set<TaskStatus>(["done", "cancelled", "failed"]),
  });
  assert.deepEqual(excluded.deletable, []);
  assert.deepEqual(excluded.skipped, { active: [], retryable: [], unnotified: [] });
});

test("U2 failed 用尽（attempts==maxAttempts）两变体：未通知不可清 / notifiedAt>0 → deletable", () => {
  const now = NOW;
  const unnotified = makeTask({
    taskId: "t-fail-un",
    status: "failed",
    attempts: 3,
    maxAttempts: 3,
    notifiedAt: 0,
    updatedAt: now - 10 * MINUTE,
  });
  const notified = makeTask({
    taskId: "t-fail-nt",
    status: "failed",
    attempts: 3,
    maxAttempts: 3,
    notifiedAt: now - 10 * MINUTE,
    updatedAt: now - 10 * MINUTE,
  });
  // 两变体均真终态（attempts 用尽）
  assert.equal(isTrulyTerminal(unnotified), true);
  assert.equal(isTrulyTerminal(notified), true);

  // 变体 1：未通知 → 守卫 false → skipped.unnotified
  assert.equal(isCleanableTerminal(unnotified, now, DAY), false);
  const sel1 = selectTasksForCleanup([unnotified], now, { replayWindowMs: DAY });
  assert.deepEqual(sel1.deletable, []);
  assert.deepEqual(sel1.skipped.unnotified, [unnotified]);

  // 变体 2：notifiedAt>0 → 守卫 true → deletable
  assert.equal(isCleanableTerminal(notified, now, DAY), true);
  const sel2 = selectTasksForCleanup([notified], now, { replayWindowMs: DAY });
  assert.deepEqual(sel2.deletable, [notified]);
  assert.deepEqual(sel2.skipped.unnotified, []);
});

test("U3 abandon 来源 failed+未用尽（attempts<max，states.ts:144）：不可清 → skipped.retryable，绝不在 deletable", () => {
  const now = NOW;
  // abandon 边不 bump attempts → 持久 failed && attempts<max 的记录（下一 tick 将被 retry 复活）
  const task = makeTask({
    taskId: "t-abandon",
    status: "failed",
    attempts: 1,
    maxAttempts: 3,
    notifiedAt: now - MINUTE,
    updatedAt: now - MINUTE,
  });
  assert.equal(isTrulyTerminal(task), false);
  // 对照 queue.ts:252 字面：下一 tick 会 push retry（可复活）
  assert.equal(task.status === "failed" && task.attempts < task.maxAttempts, true);

  const sel = selectTasksForCleanup([task], now, { replayWindowMs: DAY });
  assert.deepEqual(sel.skipped.retryable, [task]);
  assert.deepEqual(sel.deletable, []);
  assert.equal(sel.skipped.active.length, 0);
  assert.equal(sel.skipped.unnotified.length, 0);
});

test("U4 spawnFailed 来源：(a) attempts 用尽 failed → 真终态可清；(b) attempts 未用尽 queued → skipped.active", () => {
  const now = NOW;
  // (a) 3 次 spawn 失败累积 attempts:3==maxAttempts 后 exhausted → failed 终态
  const exhausted = makeTask({
    taskId: "t-spawn-a",
    status: "failed",
    attempts: 3,
    maxAttempts: 3,
    notifiedAt: now - MINUTE,
    updatedAt: now - MINUTE,
  });
  // (b) 中间态：spawnFailed → queued 且 attempts 2<3（states.ts:122-125 表 8）
  const requeued = makeTask({
    taskId: "t-spawn-b",
    status: "queued",
    attempts: 2,
    maxAttempts: 3,
  });
  // 判定只看 status + attempts 数值，与 attempt 来源无关
  assert.equal(isTrulyTerminal(exhausted), true);
  assert.equal(isTrulyTerminal(requeued), false);

  const sel = selectTasksForCleanup([exhausted, requeued], now, {
    replayWindowMs: DAY,
  });
  assert.deepEqual(sel.deletable, [exhausted]);
  assert.deepEqual(sel.skipped.active, [requeued]); // (b) 在活跃组，不在 deletable
});

test("U5 守卫边界：未通知 + 恰 24h 仍不可清（严格 >，D-A），+1ms 才可清；契约校验非有限/≤0 → TypeError", () => {
  const T = NOW;
  // 未通知 + updatedAt=T；REPLAY_WINDOW_MS=24h（farm.ts:63 filterReplay 对 ≤24h 仍补发）
  const task = makeTask({
    taskId: "t-edge",
    status: "done",
    notifiedAt: 0,
    updatedAt: T,
  });
  // 恰 24h：now-updatedAt === replayWindowMs → 仍处补发窗内（true 才可清，严格 >）
  assert.equal(isCleanableTerminal(task, T + DAY, DAY), false);
  const sel1 = selectTasksForCleanup([task], T + DAY, { replayWindowMs: DAY });
  assert.deepEqual(sel1.deletable, []);
  assert.deepEqual(sel1.skipped.unnotified, [task]);
  // +1ms：now-updatedAt > replayWindowMs → 越过补发窗 → deletable
  assert.equal(isCleanableTerminal(task, T + DAY + 1, DAY), true);
  const sel2 = selectTasksForCleanup([task], T + DAY + 1, { replayWindowMs: DAY });
  assert.deepEqual(sel2.deletable, [task]);
  assert.deepEqual(sel2.skipped.unnotified, []);

  // 契约校验：now 非有限数 / replayWindowMs 非有限数或 ≤0 → TypeError
  assert.throws(() => isCleanableTerminal(task, Number.NaN, DAY), TypeError);
  assert.throws(() => isCleanableTerminal(task, T + DAY, Number.NaN), TypeError);
  assert.throws(() => isCleanableTerminal(task, T + DAY, 0), TypeError);
  assert.throws(() => isCleanableTerminal(task, T + DAY, -1), TypeError);
});

test("U6 splitTasksForDisplay 截断切分：活跃全显 + 终态 createdAt ASC 取末 N；recentN=0/999；纯性不修改入参", () => {
  const make = (taskId: string, status: TaskStatus, createdAt: number): TaskRecord =>
    makeTask({ taskId, status, createdAt, updatedAt: createdAt });
  // 5 任务：2 活跃 + 3 终态（createdAt t1<t2<t3）
  const queued = make("q", "queued", 100);
  const running = make("r", "running", 200);
  const t1 = make("t1", "done", 300);
  const t2 = make("t2", "failed", 400);
  const t3 = make("t3", "cancelled", 500);
  const all = [queued, running, t1, t2, t3];
  const snapshot = all.slice(); // 纯性基线

  // recentN=2：active 全显；recent = 终态按 createdAt ASC 排序后取末 2（t2、t3）
  const got = splitTasksForDisplay(all, 2);
  assert.deepEqual(got.active, [queued, running]);
  assert.deepEqual(got.recent, [t2, t3]);
  assert.equal(got.active.length + got.recent.length, 4); // M = 2 + min(3,2)

  // recentN=0 → recent=[]
  const zero = splitTasksForDisplay(all, 0);
  assert.deepEqual(zero.active, [queued, running]);
  assert.deepEqual(zero.recent, []);

  // recentN=999（超终态数）→ 不剪裁全取（含可复活 failed 的展示口径）
  const allN = splitTasksForDisplay(all, 999);
  assert.deepEqual(allN.active, [queued, running]);
  assert.deepEqual(allN.recent, [t1, t2, t3]);

  // 纯性：入参数组未被修改
  assert.deepEqual(all, snapshot);

  // 契约校验：recentN 非整数或 <0 → TypeError
  assert.throws(() => splitTasksForDisplay(all, -1), TypeError);
  assert.throws(() => splitTasksForDisplay(all, 1.5), TypeError);
});