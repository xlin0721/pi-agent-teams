// src/display/format.ts
// 纯渲染文本原语（farm / probe / display 共用口径）。零依赖、零副作用、零落盘。
// 拆环（票 03 总监发现 #1）：formatDurationMs 原在 farm.ts，被 probe.ts 反向 import
// 成 farm↔probe 模块环——迁到 display 层（farm 与 probe 都允许 import display，
// 环断开，单一事实源 = 本文件）。

/** 时长渲染（耗时列/摘要文本共用口径）：<1s 取 ms、<1m 取 0.1s、≥1m 取 m+s。 */
export function formatDurationMs(ms: number): string {
  const value = Number.isFinite(ms) ? ms : 0;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}
