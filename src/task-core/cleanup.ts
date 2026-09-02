// src/task-core/cleanup.ts
// 终态清理纯逻辑（票 02）：真终态判定 / 通知守卫 / 选择分组 / 显示切分。
//
// 依据：.scratch/task-cleanup/spec.md v3 §二/§五.2 + 票 02 已批准 Plan（ba315aafb059/6c76c73b-4f9）。
// 关键规则：
//   - 纯逻辑、零 I/O、零 SDK、零运行时依赖：仅 import type（node 22 type-stripping 下被完整擦除）。
//   - isTrulyTerminal 与 queue.ts:252 retry 判据（failed && attempts<maxAttempts）逐字互否：
//     清理/GC 所选 deletable 中不存在即将被队列复活的任务。
//   - 通知守卫（PRD §4.9）：notifiedAt>0（已确认）或已越过补发窗（严格 > 才可清，D-A）。
//   - 互斥分组由判定顺序构造：全覆盖、无重叠、幂等；纯函数不修改入参数组。

import type { TaskRecord } from "./store.ts";
import type { TaskStatus } from "./states.ts";

/** selectTasksForCleanup 的 skipped 分组名：活跃 / 可复活（failed 未用尽）/ 未通知 */
export type CleanupSkipGroup = "active" | "retryable" | "unnotified";

/** selectTasksForCleanup 的返回：可删集 + 三组跳过集（均为全新数组）。 */
export interface CleanupSelection {
  deletable: TaskRecord[];
  skipped: Record<CleanupSkipGroup, TaskRecord[]>;
}

/**
 * 真终态判定（与 queue.ts:252 retry 条件逐字互否）。
 * queue: `task.status === "failed" && task.attempts < task.maxAttempts` → retry（可复活）；
 * 本谓词: {done, aborted, cancelled} ∪ (failed && !(attempts < maxAttempts))。
 * - failed 分支以 `!(attempts < maxAttempts)` 字面取反：对任何输入（含非有限数畸形）
 *   都与 queue「非 < 即终态跳过」行为一致，且与 RETRY 恰互补。
 * - done/cancelled 封闭零出边（states.ts:79）；aborted 唯一出边是人工 resume（非队列自动复活）。
 * - timeout 是静止非终态（自动出路在 pass B：retry/exhausted/迟到修正），不提前放行。
 * 无异常、无副作用；不读任何外部状态。
 */
export function isTrulyTerminal(task: TaskRecord): boolean {
  return (
    task.status === "done" ||
    task.status === "aborted" ||
    task.status === "cancelled" ||
    (task.status === "failed" && !(task.attempts < task.maxAttempts))
  );
}

/**
 * 可清判定：真终态 ∧ 通知守卫通过。
 * 守卫 = notifiedAt > 0（结果摘要/完成通知已送达主会话）∨ (now - updatedAt) > replayWindowMs。
 * 严格 >（D-A）：恰 = replayWindowMs 仍处补发窗内（farm.ts:301 filterReplay 对 ≤24h 补发，
 * 先删会丢通知，违 PRD §4.9）；+1ms 才算越过补发窗。
 * 契约校验（与 filterReplay 同风格）：now 非有限数 / replayWindowMs 非有限数或 ≤0 → TypeError。
 * 非真终态直接 false（守卫不判）。
 */
export function isCleanableTerminal(
  task: TaskRecord,
  now: number,
  replayWindowMs: number,
): boolean {
  if (!Number.isFinite(now)) {
    throw new TypeError(`isCleanableTerminal: now 必须为有限数，收到 ${JSON.stringify(now)}`);
  }
  if (!Number.isFinite(replayWindowMs) || replayWindowMs <= 0) {
    throw new TypeError(
      `isCleanableTerminal: replayWindowMs 必须为有限正数，收到 ${JSON.stringify(replayWindowMs)}`,
    );
  }
  if (!isTrulyTerminal(task)) return false;
  return task.notifiedAt > 0 || now - task.updatedAt > replayWindowMs;
}

/**
 * 选择可清任务集 + 跳过分组（spec §二/§五.2）。互斥由判定顺序构造，全覆盖、无重叠：
 *  1) status ∈ {queued, running, timeout} → skipped.active；
 *  2) status === "failed" && attempts < maxAttempts（与 queue.ts:252 同字面）→ skipped.retryable；
 *  3) 真终态且 status ∉ opts.statuses → 不入任何组（白名单外不判定；aborted 保留数由消费方自统计）；
 *  4) 真终态且守卫不过（isCleanableTerminal=false）→ skipped.unnotified；
 *  5) 其余 → deletable。
 * opts.statuses 缺省 = 真终态四态 {done, aborted, cancelled, failed}（纯逻辑层中立，无产品预设，
 * D-B）。消费方（03 sweep / 05 farm_cleanup）须显式传 {done, cancelled, failed} 实现
 * 「aborted 默认排除」。
 * 纯函数：不修改入参数组，返回全新对象；幂等。
 */
export function selectTasksForCleanup(
  tasks: readonly TaskRecord[],
  now: number,
  opts: { replayWindowMs: number; statuses?: ReadonlySet<TaskStatus> },
): CleanupSelection {
  const statuses =
    opts.statuses ??
    new Set<TaskStatus>(["done", "aborted", "cancelled", "failed"]);
  const deletable: TaskRecord[] = [];
  const skipped: Record<CleanupSkipGroup, TaskRecord[]> = {
    active: [],
    retryable: [],
    unnotified: [],
  };
  for (const task of tasks) {
    if (
      task.status === "queued" ||
      task.status === "running" ||
      task.status === "timeout"
    ) {
      skipped.active.push(task);
      continue;
    }
    if (task.status === "failed" && task.attempts < task.maxAttempts) {
      skipped.retryable.push(task);
      continue;
    }
    // 至此必为真终态（done/aborted/cancelled，或 failed 且 attempts 已用尽）
    if (!statuses.has(task.status)) continue; // 白名单外不判定、不入任何组
    if (isCleanableTerminal(task, now, opts.replayWindowMs)) {
      deletable.push(task);
    } else {
      skipped.unnotified.push(task);
    }
  }
  return { deletable, skipped };
}

/** createdAt ASC + taskId 破序（与 probe.ts sortTasksForDisplay / queue pass C 同键，确定性）。 */
function compareByCreatedAtThenId(a: TaskRecord, b: TaskRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/**
 * 显示切分（spec §五.2，工具侧兜底；面板 active-only 不用）：
 * - active = 全部 queued|running|timeout（全显，含排队；timeout 语义同 F2 静止待判）；
 * - recent = 非活跃集（done|aborted|failed|cancelled，含可复活 failed——展示口径
 *   「终态 = 非活跃」，D-C）按 createdAt ASC + taskId 破序（确定性）后取末 N 条（= 最近 N）。
 * - 行数 M = active.length + min(终态数, recentN)（与评审 F6/M 公式一致）。
 * 契约校验：recentN 非整数或 < 0 → TypeError（比 Plan「<0 → TypeError」更严：
 * 防 NaN/小数经 slice 产生非预期截断）；recentN = 0 → recent: []；recentN ≥ 终态数 → 全取不剪裁。
 * 纯函数：不修改入参数组（active/recent 均为全新数组）。
 */
export function splitTasksForDisplay(
  tasks: readonly TaskRecord[],
  recentN: number,
): { active: TaskRecord[]; recent: TaskRecord[] } {
  if (!Number.isInteger(recentN) || recentN < 0) {
    throw new TypeError(
      `splitTasksForDisplay: recentN 必须为非负整数，收到 ${JSON.stringify(recentN)}`,
    );
  }
  const active: TaskRecord[] = [];
  const terminal: TaskRecord[] = [];
  for (const task of tasks) {
    if (
      task.status === "queued" ||
      task.status === "running" ||
      task.status === "timeout"
    ) {
      active.push(task);
    } else {
      terminal.push(task);
    }
  }
  terminal.sort(compareByCreatedAtThenId);
  const recent =
    recentN === 0
      ? []
      : recentN >= terminal.length
        ? terminal
        : terminal.slice(terminal.length - recentN);
  return { active, recent };
}