// src/task-core/states.test.ts
// transition() 单测：迁移表逐行断言 + 非法组合（参数化）+ 纯性。
// 只断言外部行为（输入→输出/抛错），不窥探内部实现。
// 运行：cd src/task-core && node --test states.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transition,
  IllegalTransitionError,
  type TaskStatus,
  type TransitionEvent,
  type TransitionCtx,
} from "./states.ts";

/** 18 行迁移表展开的 19 条合法边（含每行期望的次态与 actions）。 */
interface ValidRow {
  from: TaskStatus | null;
  event: TransitionEvent;
  ctx?: TransitionCtx;
  to: TaskStatus;
  actions: unknown[];
}

const VALID_ROWS: ValidRow[] = [
  // 表 1
  { from: null, event: "enqueue", to: "queued", actions: [{ kind: "writeTask" }] },
  // 表 2
  { from: "queued", event: "dequeue", to: "running", actions: [{ kind: "acquireSlot" }] },
  // 表 3
  { from: "queued", event: "cancel", to: "cancelled", actions: [{ kind: "markCancelled" }] },
  // 表 4
  { from: "queued", event: "resume", to: "queued", actions: [{ kind: "fillResumeFrom" }] },
  // 表 5
  { from: "running", event: "paneDone", to: "done", actions: [{ kind: "readDoneStatus" }] },
  // 表 6（pane 消失 tick 注入同走此行）
  { from: "running", event: "paneAborted", to: "aborted", actions: [{ kind: "readAbortedStatus" }, { kind: "notifyMain", reason: "aborted" }] },
  // 表 7（信号消费：actions=[markTimeout, consumeSignal] 顺序固定）
  { from: "running", event: "deadline", to: "timeout", actions: [{ kind: "markTimeout" }, { kind: "consumeSignal" }] },
  // 表 8（spawn 抛错回队：动态 retry，attempts 0→1，退避 5s）
  { from: "running", event: "spawnFailed", ctx: { attempts: 0, backoffSecs: [5, 30] }, to: "queued", actions: [{ kind: "retry", attempt: 1, backoffSecs: 5 }] },
  // 表 9（spawn 失败用尽：killPane 前置 + 通知）
  { from: "running", event: "exhausted", to: "failed", actions: [{ kind: "killPane" }, { kind: "notifyMain", reason: "attemptsExhausted" }] },
  // 表 10（顺序固定：killPane → markCancelled）
  { from: "running", event: "cancel", to: "cancelled", actions: [{ kind: "killPane" }, { kind: "markCancelled" }] },
  // 表 11
  { from: "running", event: "steer", to: "running", actions: [{ kind: "writeInbox" }] },
  // 表 12（迟到 done 修正）
  { from: "timeout", event: "paneDone", to: "done", actions: [{ kind: "readDoneStatus" }] },
  // 表 13（迟到 aborted 修正）
  { from: "timeout", event: "paneAborted", to: "aborted", actions: [{ kind: "readAbortedStatus" }, { kind: "notifyMain", reason: "aborted" }] },
  // 表 14（killPane 前置 + 动态 retry：attempts 0→1，退避 5s）
  { from: "timeout", event: "retry", ctx: { attempts: 0, backoffSecs: [5, 30] }, to: "queued", actions: [{ kind: "killPane" }, { kind: "retry", attempt: 1, backoffSecs: 5 }] },
  // 表 15（二次重试：attempts 1→2，退避 30s）
  { from: "failed", event: "retry", ctx: { attempts: 1, backoffSecs: [5, 30] }, to: "queued", actions: [{ kind: "killPane" }, { kind: "retry", attempt: 2, backoffSecs: 30 }] },
  // 表 16（failed/timeout + attempts 用尽 → failed 终态；killPane 前置防残留）
  { from: "failed", event: "exhausted", to: "failed", actions: [{ kind: "killPane" }, { kind: "notifyMain", reason: "attemptsExhausted" }] },
  { from: "timeout", event: "exhausted", to: "failed", actions: [{ kind: "killPane" }, { kind: "notifyMain", reason: "attemptsExhausted" }] },
  // 表 17
  { from: "aborted", event: "resume", to: "queued", actions: [{ kind: "fillResumeFrom" }] },
  // 表 18（超时未恢复）
  { from: "aborted", event: "abandon", to: "failed", actions: [{ kind: "notifyMain", reason: "resumeTimeout" }] },
];

const ALL_STATES: Array<TaskStatus | null> = [
  null,
  "queued",
  "running",
  "done",
  "aborted",
  "failed",
  "timeout",
  "cancelled",
];

const ALL_EVENTS: TransitionEvent[] = [
  "enqueue",
  "dequeue",
  "cancel",
  "resume",
  "paneDone",
  "paneAborted",
  "deadline",
  "steer",
  "retry",
  "spawnFailed",
  "exhausted",
  "abandon",
];

// ---------- 迁移表逐行断言（每行一个用例） ----------

for (const row of VALID_ROWS) {
  test(`迁移表逐行：${row.from ?? "(null)"} × ${row.event} → ${row.to}`, () => {
    const result = transition(row.from, row.event, row.ctx);
    assert.deepEqual(result, { next: row.to, actions: row.actions });
  });
}

// ---------- 非法组合（参数化） ----------

test("非法组合：全枚举（8 态 × 12 事件 − 19 条合法边）均抛 IllegalTransitionError", () => {
  const valid = new Set(VALID_ROWS.map((r) => `${r.from}|${r.event}`));
  let illegalCount = 0;
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      if (valid.has(`${state}|${event}`)) continue;
      illegalCount += 1;
      // retry/spawnFailed 的非法源状态也带上 ctx，证明抛的是 IllegalTransitionError 而非 TypeError
      assert.throws(
        () => transition(state, event, { attempts: 0, backoffSecs: [5, 30] }),
        IllegalTransitionError,
      );
    }
  }
  assert.equal(illegalCount, 8 * 12 - VALID_ROWS.length);
});

test("done/cancelled 封闭：收任意事件抛 IllegalTransitionError", () => {
  for (const state of ["done", "cancelled"] as TaskStatus[]) {
    for (const event of ALL_EVENTS) {
      assert.throws(
        () => transition(state, event, { attempts: 0, backoffSecs: [5, 30] }),
        IllegalTransitionError,
      );
    }
  }
});

test("IllegalTransitionError 是 Error 子类且携带 state/event", () => {
  try {
    transition("done", "dequeue");
    assert.fail("应当抛错");
  } catch (err) {
    assert.ok(err instanceof IllegalTransitionError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "IllegalTransitionError");
    assert.equal(err.state, "done");
    assert.equal(err.event, "dequeue");
  }
});

// ---------- retry ctx 语义 ----------

test("retry/spawnFailed 缺 ctx → TypeError", () => {
  assert.throws(() => transition("failed", "retry"), TypeError);
  assert.throws(() => transition("timeout", "retry"), TypeError);
  assert.throws(() => transition("failed", "retry", null as unknown as TransitionCtx | undefined), TypeError);
  assert.throws(() => transition("running", "spawnFailed"), TypeError);
  assert.throws(() => transition("running", "spawnFailed", null as unknown as TransitionCtx | undefined), TypeError);
});

test("retry：attempts 越界取末项退避（容错）", () => {
  const result = transition("timeout", "retry", { attempts: 5, backoffSecs: [5, 30] });
  assert.deepEqual(result, {
    next: "queued",
    actions: [{ kind: "killPane" }, { kind: "retry", attempt: 6, backoffSecs: 30 }],
  });
  // 空退避表容错：退避 0，attempt 正常递增
  const empty = transition("failed", "retry", { attempts: 0, backoffSecs: [] });
  assert.deepEqual(empty, {
    next: "queued",
    actions: [{ kind: "killPane" }, { kind: "retry", attempt: 1, backoffSecs: 0 }],
  });
});

// ---------- 纯性 ----------

test("纯性：同输入两次调用结果 deepEqual，返回值可被篡改而不影响后续调用", () => {
  const ctx = { attempts: 1, backoffSecs: [5, 30] };
  const first = transition("failed", "retry", ctx);
  const second = transition("failed", "retry", ctx);
  assert.deepEqual(first, second);

  // 篡改返回值（actions 对象与数组），下一次调用不受影响
  first.actions[0].kind = "consumeSignal";
  first.actions.push({ kind: "writeTask" });
  const third = transition("failed", "retry", ctx);
  assert.deepEqual(third, {
    next: "queued",
    actions: [{ kind: "killPane" }, { kind: "retry", attempt: 2, backoffSecs: 30 }],
  });

  // 静态行动作同样每次返回全新对象
  const staticFirst = transition("running", "cancel");
  staticFirst.actions[0].kind = "writeInbox";
  const staticAgain = transition("running", "cancel");
  assert.deepEqual(staticAgain, {
    next: "cancelled",
    actions: [{ kind: "killPane" }, { kind: "markCancelled" }],
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("ctx 只读：冻结的 ctx 传入后不被改写", () => {
  const ctx = deepFreeze({ attempts: 1, backoffSecs: [5, 30] });
  const snapshot = { attempts: 1, backoffSecs: [5, 30] };
  const result = transition("timeout", "retry", ctx);
  assert.deepEqual(result, {
    next: "queued",
    actions: [{ kind: "killPane" }, { kind: "retry", attempt: 2, backoffSecs: 30 }],
  });
  assert.deepEqual(ctx, snapshot);
});

test("actions 为纯数据：无函数值，可 JSON 序列化往返", () => {
  for (const row of VALID_ROWS) {
    const result = transition(row.from, row.event, row.ctx);
    for (const action of result.actions) {
      assert.equal(typeof action, "object");
      assert.ok(action !== null);
      for (const value of Object.values(action)) {
        assert.notEqual(typeof value, "function");
      }
    }
    // JSON 往返等价 ⇒ 纯数据（无函数/非 JSON 值）
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});
