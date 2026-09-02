// src/task-core/constants.ts
// task-core 层共享常量（票 09 常量提共享：分层合规——单一事实源下沉，杜绝本地副本漂移）。
//
// 依据：docs-internal/PRD-v3.md §13.2/§13.3 + .scratch/task-cleanup/spec.md（通知守卫
// 严格 >，D-A）+ v2 部署版实测口径。分层纪律：task-core 层不得 import farm 层（装配层），
// 故数值存于 task-core 共享层；farm.ts 经再导出（export { REPLAY_WINDOW_MS }）维持既有
// 消费方（index.ts / farm.test.ts 自 farm.ts import）零迁移。
//
// 消费方（同一来源）：
//   - farm.ts filterReplay：updatedAt 距今 ≤24h 的未通知终态任务在 session_start 补发；
//   - store.ts deleteTask 缺省守卫窗（原 store.ts 本地副本常量已删除）；
//   - cleanup.ts selectTasksForCleanup 缺省守卫窗（调用方仍可显式传窄/宽窗）；
//   - farm.ts sweepTasks 的 GC_TASKS_TTL_MS 为独立常量（当前同值，兜底下限 vs 补发窗
//     是两个政策旋钮，见 farm.ts sweepTasks 头注释 Suggestion 03 处置）。

/** 补发窗/通知守卫：24h。
 *  ① 补发：session_start 时 updatedAt 距今 ≤24h 的未通知终态任务重发 farm.done；
 *  ② 清理守卫：严格 > 才可清（恰 = 24h 仍处补发窗内——先删会丢通知，违 PRD §4.9）。
 *  数值 pin：PRD §13.2 + v2 部署版实测口径。改动属 cross-cutting 决策（farm 补发 /
 *  store deleteTask / cleanup 选择器三消费方联动），须显式知晓。 */
export const REPLAY_WINDOW_MS = 24 * 3600 * 1000;
