// src/display/adapt.ts
// 装配层适配（display 层）：PaneInfo[] → farm 期望的 pane_id 字符串数组。
// 唯一消费者 = index.ts 装配点与测试（本模块零 I/O、零运行时依赖，仅 type import）。
//
// 语义来源：index.ts 装配处 adaptListPanes（修复轮「装配契约断接」HIGH）——
// farm 契约收 string[]（05 farm.diffPanes 期望）；04 实现返回 PaneInfo[]，直传对象
// 数组会让 diffPanes 把一切条目当非字符串忽略 → 实际 paneId 集恒空 → 3s 探测循环
// 把 running 全量误判 gone 注入 aborted（实机 3s 全量误杀）。故在此把 pane_id 转
// 字符串：缺失/空 → 剔除（版本漂移容错形状，空项不进探测差集）。

import type { PaneInfo } from "./protocol.ts";

/**
 * PaneInfo 对象数组 → pane_id 字符串数组（farm 契约收 string[]）。
 * pane_id 缺失（版本漂移容错形状）→ 空串再剔除；存在则 String(pane_id) 转字符串。
 * 纯函数：不改入参、无副作用、零依赖。
 */
export function adaptListPanes(panes: readonly PaneInfo[]): string[] {
  return panes
    .map((p) => (p.pane_id === undefined ? "" : String(p.pane_id)))
    .filter((id) => id !== "");
}
