// src/task-core/states.ts
// 状态机核心：7 态任务状态机的权威演化逻辑（transition 纯函数）。
//
// 依据：.scratch/m1b-task-core/issues/01-states.md 已批准方案
//   + .scratch/m1b-task-core/spec.md 内联迁移表（PRD-v3.md §13.3 单一事实源）。
// 队列/状态面板/watchdog 共享这份唯一逻辑；本模块零依赖、零 import。
// node 22 type-stripping 约束：禁 enum/namespace/构造器参数属性（本文件均未使用）。

/**
 * 任务状态（7 态）。task record.status 字段值域（PRD §13.3）。
 * TaskStatus 单一权威在此声明：store.ts / queue.ts 均以 import type 引用，不再本地声明。
 */
export type TaskStatus =
  | "queued"
  | "running"
  | "done"
  | "aborted"
  | "failed"
  | "timeout"
  | "cancelled";

/**
 * 事件集（12 事件）。retry/spawnFailed/exhausted 由调用方按 attempts<maxAttempts
 * 判定后发对应事件，transition 保持纯（不读 maxAttempts、不做判定）。
 */
export type TransitionEvent =
  | "enqueue"
  | "dequeue"
  | "cancel"
  | "resume"
  | "paneDone"
  | "paneAborted"
  | "deadline"
  | "steer"
  | "retry"
  | "spawnFailed"
  | "exhausted"
  | "abandon";

/**
 * retry / spawnFailed 事件所需的上下文（其余事件忽略 ctx，可缺省）。
 * attempts   = 事件前 task record.attempts（已用尝试次数）
 * backoffSecs = 退避表（秒），如 [5, 30]；按 attempts 索引，越界取末项（容错）
 */
export interface TransitionCtx {
  /** 事件前已用尝试次数 */
  attempts?: number;
  /** 退避表（秒）；索引越界取末项（容错） */
  backoffSecs?: number[];
}

/**
 * actions 词汇表（已锁定，03-queue 将按此消费）。纯数据对象，禁函数/副作用：
 *   writeTask / acquireSlot / markCancelled / fillResumeFrom / readDoneStatus /
 *   readAbortedStatus / markTimeout / consumeSignal / killPane / writeInbox /
 *   retry{attempt,backoffSecs} /
 *   notifyMain{reason:"attemptsExhausted"|"resumeTimeout"|"aborted"}
 */
export type TransitionAction =
  | { kind: "writeTask" }
  | { kind: "acquireSlot" }
  | { kind: "markCancelled" }
  | { kind: "fillResumeFrom" }
  | { kind: "readDoneStatus" }
  | { kind: "readAbortedStatus" }
  | { kind: "markTimeout" }
  | { kind: "consumeSignal" }
  | { kind: "killPane" }
  | { kind: "writeInbox" }
  | { kind: "retry"; attempt: number; backoffSecs: number }
  | { kind: "notifyMain"; reason: "attemptsExhausted" | "resumeTimeout" | "aborted" };

/** transition 的返回：次态 + 待执行动作（纯数据）。 */
export interface TransitionResult {
  next: TaskStatus;
  actions: TransitionAction[];
}

/** 非法 (state, event) 组合。done/cancelled 封闭：收任意事件抛此错。 */
export class IllegalTransitionError extends Error {
  declare readonly state: TaskStatus | null;
  declare readonly event: TransitionEvent;
  constructor(state: TaskStatus | null, event: TransitionEvent) {
    super(`illegal transition: ${state ?? "(none)"} × ${event}`);
    this.name = "IllegalTransitionError";
    this.state = state;
    this.event = event;
  }
}

/** 迁移表一行（PRD §13.3 内联表）。 */
interface Row {
  from: TaskStatus | null;
  event: TransitionEvent;
  to: TaskStatus;
  /** retry/spawnFailed 行动作依赖 ctx，表中置空、由 transition 动态计算；其余行为静态动作 */
  actions: TransitionAction[];
}

/**
 * 迁移表：PRD §13.3（M2 修订版）18 行（"failed/timeout + exhausted" 覆盖 2 个源状态，
 * 故展开为 19 条具体边）。顺序与 spec 内联表一致。
 * running+cancel 的 [killPane, markCancelled] 顺序固定；
 * running+deadline 的 [markTimeout, consumeSignal] 顺序固定；
 * timeout|failed+retry 的 [killPane, …retry] 顺序固定（重跑前先杀旧 pane）。
 */
const TABLE: readonly Row[] = [
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
  // 表 6（pane 消失 tick 注入 {paneGone} 同走此行；aborted 文件唯一写者=wrapper）
  { from: "running", event: "paneAborted", to: "aborted", actions: [{ kind: "readAbortedStatus" }, { kind: "notifyMain", reason: "aborted" }] },
  // 表 7（信号消费：删除旧 done|aborted 信号文件，重跑不被残留信号污染）
  { from: "running", event: "deadline", to: "timeout", actions: [{ kind: "markTimeout" }, { kind: "consumeSignal" }] },
  // 表 8（spawn 抛错 → attempts+1 回队，动态 retry；用尽走 exhausted）
  { from: "running", event: "spawnFailed", to: "queued", actions: [] },
  // 表 9（spawn 失败用尽 → failed 终态 + killPane + 通知；killPane 前置杀残留 pane）
  { from: "running", event: "exhausted", to: "failed", actions: [{ kind: "killPane" }, { kind: "notifyMain", reason: "attemptsExhausted" }] },
  // 表 10（顺序固定：killPane → markCancelled）
  { from: "running", event: "cancel", to: "cancelled", actions: [{ kind: "killPane" }, { kind: "markCancelled" }] },
  // 表 11（状态不变；投递态在 inbox 消息文件推进，见 04-steer）
  { from: "running", event: "steer", to: "running", actions: [{ kind: "writeInbox" }] },
  // 表 12（迟到 done 修正：不重跑已完成任务）
  { from: "timeout", event: "paneDone", to: "done", actions: [{ kind: "readDoneStatus" }] },
  // 表 13（迟到 aborted 修正）
  { from: "timeout", event: "paneAborted", to: "aborted", actions: [{ kind: "readAbortedStatus" }, { kind: "notifyMain", reason: "aborted" }] },
  // 表 14（killPane 前置：重跑前先杀旧 paneId，防双 pane）
  { from: "timeout", event: "retry", to: "queued", actions: [{ kind: "killPane" }] },
  // 表 15
  { from: "failed", event: "retry", to: "queued", actions: [{ kind: "killPane" }] },
  // 表 16（failed/timeout + exhausted → failed 终态；killPane 前置防挂死 pane 永久残留）
  { from: "failed", event: "exhausted", to: "failed", actions: [{ kind: "killPane" }, { kind: "notifyMain", reason: "attemptsExhausted" }] },
  { from: "timeout", event: "exhausted", to: "failed", actions: [{ kind: "killPane" }, { kind: "notifyMain", reason: "attemptsExhausted" }] },
  // 表 17
  { from: "aborted", event: "resume", to: "queued", actions: [{ kind: "fillResumeFrom" }] },
  // 表 18（超时未恢复）
  { from: "aborted", event: "abandon", to: "failed", actions: [{ kind: "notifyMain", reason: "resumeTimeout" }] },
];

/**
 * retry 动作（retry 与 spawnFailed 共用）：attempt = 事件后计数值（ctx.attempts + 1）；
 * 退避按 ctx.attempts 索引 backoffSecs，越界取末项（容错）；
 * 表为空/缺省时退避 0（容错）。纯计算，不读外部状态。
 */
function buildRetry(ctx: TransitionCtx): TransitionAction {
  const rawAttempts = ctx.attempts;
  const prevAttempts =
    typeof rawAttempts === "number" && Number.isFinite(rawAttempts)
      ? Math.max(0, Math.trunc(rawAttempts))
      : 0;
  const schedule = Array.isArray(ctx.backoffSecs) ? ctx.backoffSecs : [];
  const backoffSecs =
    schedule.length === 0
      ? 0
      : schedule[Math.min(prevAttempts, schedule.length - 1)];
  return { kind: "retry", attempt: prevAttempts + 1, backoffSecs };
}

/**
 * 状态机权威演化逻辑（纯函数）。
 * - 合法 (state, event) → { next, actions }（actions 为全新纯数据对象，无副作用）
 * - 非法组合（含 done/cancelled 收任意事件）→ IllegalTransitionError
 * - retry/spawnFailed 缺 ctx → TypeError（ctx 缺失/为 null；其余事件忽略 ctx）
 * - 仲裁（同 tick pane 信号优先于 deadline）归 03-queue，本函数只处理单事件
 */
export function transition(
  state: TaskStatus | null,
  event: TransitionEvent,
  ctx?: TransitionCtx,
): TransitionResult {
  const row = TABLE.find((r) => r.from === state && r.event === event);
  if (row === undefined) {
    throw new IllegalTransitionError(state, event);
  }
  if (event === "retry" || event === "spawnFailed") {
    if (ctx === undefined || ctx === null) {
      throw new TypeError(`transition: ${event} 需要 ctx（attempts/backoffSecs）`);
    }
    // 动态 retry 挂在静态动作（如 killPane）之后；每次返回全新数组与对象
    return {
      next: row.to,
      actions: [...row.actions.map((action) => ({ ...action })), buildRetry(ctx)],
    };
  }
  // 每次返回全新 actions 数组与对象，杜绝共享引用（纯性保证）
  return { next: row.to, actions: row.actions.map((action) => ({ ...action })) };
}
