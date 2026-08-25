// src/display/grid.ts
// 网格落点纯函数（display 层）：WEZTERM_PANE 解析 + 定向分裂「最大 pane」落点决策 +
// split-pane 参数装配。零 I/O、零 pi SDK、零 node: import，仅 import type PaneInfo。
//
// 权威事实来源：.scratch/m7-closeout/spike-facts.md（票 01 A/B 定案）。
//   - 定案 B：--pane-id 定向分裂「面积最大 pane」达成平衡（main 恒占 ~50%，farm
//     pane 在另一半内递归二等分）；A 案 --top-level 每次新 pane 占整半、旧内容整体
//     挤压，与平衡相悖（spike §1），已否定；
//   - --percent 50 精确对半（spike §3）；方向按目标 pane 长宽比：cols>rows → right
//     （竖切宽 pane），否则 bottom（横切高 pane）；
//   - 面积 = size.rows*size.cols，任一缺失视为不可比（跳过该 pane，spike 字段漂移
//     防御口径与 protocol.ts 一致）。
// 本模块零 task-core/store import（display 不感知农场）；落点只做 spawn 时刻尽力平衡，
// 之后不跟踪（spike §5 无自动 reflow，已知限制）。

import type { PaneInfo } from "./protocol.ts";

/** 网格落点决策结果：direction 必填；paneId / topLevel / percent 按策略填。 */
export interface GridPlacement {
  direction: "left" | "right" | "top" | "bottom";
  paneId?: number;
  topLevel?: boolean;
  percent?: number;
}

/** WEZTERM_PANE 纯数字串 → number；非数字 / 空 / 缺 → null（回退信号）。 */
const PANE_ID_RE = /^[0-9]+$/;

/** ownPaneId 与 p 是否同 tab（window_id 且 tab_id 均相等）。 */
function inSameTab(own: PaneInfo, p: PaneInfo): boolean {
  return p.window_id === own.window_id && p.tab_id === own.tab_id;
}

/** 取面积（rows*cols）；size/rows/cols 任一缺失 → null（不可比）。 */
function paneArea(p: PaneInfo): number | null {
  const size = p.size;
  if (size === undefined) return null;
  if (typeof size.rows !== "number" || typeof size.cols !== "number") return null;
  return size.rows * size.cols;
}

/**
 * 解析 `WEZTERM_PANE` 环境变量（纯数字字符串）→ number；非数字 / 空 / undefined →
 * null（回退信号）。pane-id 全局单调不复用（spike），纯数字即可，不做范围校验。
 */
export function parseWeztermPaneId(envValue: string | undefined): number | null {
  if (envValue === undefined) return null;
  if (!PANE_ID_RE.test(envValue)) return null;
  return Number(envValue);
}

/**
 * 定向分裂目标纯函数：过滤本窗口（ownPaneId 的 window_id/tab_id）→ 排除 ownPaneId
 * 后取面积最大者 → 方向 cols>rows ? "right" : "bottom"。排除后空集 / 面积缺失 → null。
 * PaneInfo 无「main」概念，唯一身份是 ownPaneId，不存在「非 main 退化取全体最大」分支。
 */
export function selectSplitTarget(
  panes: readonly PaneInfo[],
  ownPaneId: number,
): { paneId: number; direction: "right" | "bottom" } | null {
  const own = panes.find((p) => p.pane_id === ownPaneId);
  if (own === undefined) return null;

  let best: { paneId: number; area: number; cols: number; rows: number } | null = null;
  for (const p of panes) {
    if (p.pane_id === ownPaneId) continue; // 排除 own
    if (p.pane_id === undefined) continue; // 无 pane-id 无法定向
    if (!inSameTab(own, p)) continue; // 过滤本窗口（window_id + tab_id）
    const area = paneArea(p);
    if (area === null) continue; // 面积缺失不可比
    if (best === null || area > best.area) {
      best = { paneId: p.pane_id, area, cols: p.size!.cols!, rows: p.size!.rows! };
    }
  }
  if (best === null) return null;
  return { paneId: best.paneId, direction: best.cols > best.rows ? "right" : "bottom" };
}

/**
 * 网格落点决策：ownPaneId 不在列表 → null（回退 --right）；同 tab pane 数 ≤1 →
 * `{ direction:"right", percent:50 }`（首分裂）；否则 selectSplitTarget 结果 + percent:50；
 * selectSplitTarget 返回 null（其余 pane 均无面积）→ null（回退 --right）。
 */
export function computeGridPlacement(
  panes: readonly PaneInfo[],
  ownPaneId: number,
): GridPlacement | null {
  const own = panes.find((p) => p.pane_id === ownPaneId);
  if (own === undefined) return null;

  const sameTabCount = panes.filter((p) => inSameTab(own, p)).length;
  if (sameTabCount <= 1) return { direction: "right", percent: 50 };

  const target = selectSplitTarget(panes, ownPaneId);
  if (target === null) return null;
  return { direction: target.direction, paneId: target.paneId, percent: 50 };
}

/**
 * split-pane 参数装配纯函数：direction → flag 映射（right/bottom/left/top →
 * --right/--bottom/--left/--top）；拼 `["--" + direction, "--percent", String(percent)]`；
 * paneId 存在则前置 `["--pane-id", String(paneId)]`；topLevel 时追加 `--top-level`。
 * 不产出 `--help` 字面量（3e）。
 */
export function placementToArgs(p: GridPlacement): string[] {
  const args: string[] = [];
  if (p.paneId !== undefined) args.push("--pane-id", String(p.paneId));
  args.push("--" + p.direction, "--percent", String(p.percent ?? 50));
  if (p.topLevel) args.push("--top-level");
  return args;
}

/**
 * 组合纯函数（供票 03 index.ts 消费，下沉至此使纯决策可单测）：
 * parseWeztermPaneId(envPaneId) → null 则 null；否则 computeGridPlacement(panes, ownPaneId)。
 */
export function computePlacementFromSnapshot(
  panes: readonly PaneInfo[],
  envPaneId: string | undefined,
): GridPlacement | null {
  let ownPaneId = parseWeztermPaneId(envPaneId);
  if (ownPaneId === null) {
    // 兜底：WEZTERM_PANE 缺失/无效（pane 外进程或某些 spawn 环境不继承该变量）→
    // 用最小 pane_id 推断 own（main 通常是 pane 0，最小；pane-id 全局单调不复用，
    // spike §5）。首次分裂语义不变，多 pane 时 selectSplitTarget 仍排除 own 分裂最大 pane。
    const ids = panes.map((p) => p.pane_id).filter((id): id is number => id !== undefined);
    ownPaneId = ids.length > 0 ? Math.min(...ids) : null;
  }
  if (ownPaneId === null) return null;
  return computeGridPlacement(panes, ownPaneId);
}
