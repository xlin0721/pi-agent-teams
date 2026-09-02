// src/comm/feed.ts
// comm 面板聚合视图（票 01）：5 列台账 + usage + 投递态 + 计数行，纯渲染零副作用。
// 票 07 面板（setWidget）消费；票 04：active-only shown 源 + 行硬顶 100 + 折叠 +
// footer 简化（即清 + 合计口径注记）；票 08：recentN 复活为「最近完成 N 条」回显窗口
// （终态完成即移出活跃行，仅以计数行回显）。本模块只 import node 内置之外的零依赖
// 相对 .ts：
//   - probe.ts 四个导出（FARM_STATUS_LABELS / durationText / sortTasksForDisplay /
//     PANEL_MAX_ROWS）——feed 内本地 padCell（列宽 8/12/8/8，与表头列契约一致）。
//   - task-core/cleanup.ts 的 splitTasksForDisplay（面板 active/recent 切分唯一源，与
//     farm_status 工具侧零漂移，3a 白名单合法）。
//   - steer.ts 的 pickLatest（投递态列取该 pane 最新消息）。

import type { TaskRecord } from "../task-core/store.ts";
import type { UsageSidecar } from "../task-core/queue.ts";
import { pickLatest, type InboxMessage } from "../task-core/steer.ts";
import { splitTasksForDisplay } from "../task-core/cleanup.ts";
import {
  FARM_STATUS_LABELS,
  durationText,
  sortTasksForDisplay,
  PANEL_MAX_ROWS,
} from "../probe.ts";
import type { Presence } from "./presence.ts";
import { costAmount, DEFAULT_PRICING_TABLE, formatCost } from "../pricing.ts";
import type { PricingTable } from "../pricing.ts";

export interface FeedOptions {
  /** 时间锚（耗时/投递态）；缺省 Date.now() */
  now?: number;
  /**
   * 最近完成回显窗口（票 08）：recentN>0 时在 count/footer 行后追加一行小字
   * 「最近完成 N 条」（N = splitTasksForDisplay(tasks, recentN).recent.length，即最近
   * 终态窗口内条数；终态完成即移出活跃行，仅以计数回显，不挤占活跃行位）。
   * recentN=0/缺省 → 不回显该行（输出形状与票 04 active-only 一致，活跃行渲染
   * 不受 recentN 影响）。面板装配（index.ts refreshPanel）传 PANEL_RECENT_N=50。
   */
  recentN?: number;
  /** FE#4：行宽上限——usage/投递态列右向截断（省略号）；缺省 = 不截断 */
  maxWidth?: number;
  /** 价目表（票 05）；缺省 = DEFAULT_PRICING_TABLE，向后兼容现有测试 */
  pricing?: PricingTable;
}

/** 前 5 列（8/12/8/8 列宽/状态标签/耗时口径 + usage/投递态两列）。 */
const HEADER = "taskId   role         status   attempts 耗时 usage/费用 投递";

/** 本地 padCell（列宽 8/12/8/8，与表头列契约一致）。 */
function padCell(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function spawnRole(task: TaskRecord): string {
  const role = task.payload?.spawn?.role;
  return typeof role === "string" ? role : "";
}

/** 成本数据源（票 05）：sidecar 优先，否则 task.result.cost（有任一有效字段才算），否则 null。 */
interface CostSource {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function costSourceFor(task: TaskRecord, usage: UsageSidecar | undefined): CostSource | null {
  if (usage !== undefined) {
    return { model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  }
  const cost = task.result?.cost;
  const model = typeof cost?.model === "string" ? cost.model : "";
  const inputTokens = typeof cost?.inputTokens === "number" ? cost.inputTokens : 0;
  const outputTokens = typeof cost?.outputTokens === "number" ? cost.outputTokens : 0;
  if (model !== "" || inputTokens > 0 || outputTokens > 0) {
    return { model, inputTokens, outputTokens };
  }
  return null;
}

/** usage/费用 列（票 05）：↑N ↓N $X.XXXX；无数据 → —；未知模型 → ↑N ↓N —。 */
function usageCell(usage: UsageSidecar | undefined, task: TaskRecord, pricing: PricingTable): string {
  const source = costSourceFor(task, usage);
  if (source === null) return "—";
  const amount = costAmount(pricing, source.model, source.inputTokens, source.outputTokens);
  if (amount === null) return `↑${source.inputTokens} ↓${source.outputTokens} —`;
  return `↑${source.inputTokens} ↓${source.outputTokens} ${formatCost(amount, pricing.currency)}`;
}

function deliveryCell(latest: InboxMessage | null): string {
  if (latest === null) return "—";
  return `${latest.type}:${latest.status} @${latest.from}`;
}

/** 前 5 列（列宽 8/12/8/8 + durationText 尾列，表头列契约）。 */
function fiveCol(task: TaskRecord, now: number): string {
  const attempts = `${task.attempts}/${task.maxAttempts}`;
  return [
    padCell(task.taskId.slice(0, 8), 8),
    padCell(spawnRole(task) || "-", 12),
    padCell(FARM_STATUS_LABELS[task.status] ?? String(task.status), 8),
    padCell(attempts, 8),
    durationText(task, now),
  ].join(" ");
}

/** 右向截断加省略号（FE#4）；不超宽原样返回。 */
function truncateRight(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  return text.slice(0, maxWidth - 1) + "…";
}

/**
 * 面板聚合视图（票 04 + 票 08）：表头 + 活跃任务行（shown 源 = 活跃集 + 排序定序；
 * 终态完成即不在活跃行）+ 行硬顶 PANEL_MAX_ROWS（超出折叠「另有 K 条排队」行，footer
 * 前）+ footer（活跃/排队计数 + 即清 + 合计口径静态注记；金额求和已移除，D3-A）；
 * recentN>0 时 footer 后再加一行小字「最近完成 N 条」回显（N = 最近终态窗口条数，
 * 不挤占活跃行；recentN=0/缺省不出行）。presence 参数保留（签名兼容，不再消费存活
 * 计数）。返回 string[]（setWidget 行数组）。纯函数：不改任何输入。
 */
export function buildFeed(
  tasks: readonly TaskRecord[],
  presence: readonly Presence[],
  inboxSnapshot: readonly InboxMessage[],
  usageMap: ReadonlyMap<string, UsageSidecar>,
  opts: FeedOptions = {},
): string[] {
  const now = opts.now ?? Date.now();
  const pricing = opts.pricing ?? DEFAULT_PRICING_TABLE;
  // 最近完成回显窗口（票 08）：合法非负整数才生效（0/缺省 = 不回显行）；活跃集切分
  // 与 recentN 无关（splitTasksForDisplay 的 active 恒为 queued/running/timeout）
  const recentN =
    typeof opts.recentN === "number" && Number.isInteger(opts.recentN) && opts.recentN >= 0
      ? opts.recentN
      : 0;
  const { active, recent } = splitTasksForDisplay(tasks, recentN);
  const sorted = sortTasksForDisplay(active);
  const shown = sorted.slice(0, PANEL_MAX_ROWS);
  const maxWidth =
    typeof opts.maxWidth === "number" && Number.isFinite(opts.maxWidth) && opts.maxWidth > 0
      ? Math.floor(opts.maxWidth)
      : 0;

  const lines: string[] = [HEADER];
  for (const task of shown) {
    const paneId = task.payload?.spawn?.paneId ?? "";
    let latest: InboxMessage | null = null;
    if (paneId !== "") {
      latest = pickLatest(inboxSnapshot.filter((m) => m.to === paneId));
    }
    const row = `${fiveCol(task, now)} ${usageCell(usageMap.get(task.taskId), task, pricing)} ${deliveryCell(latest)}`;
    lines.push(maxWidth > 0 ? truncateRight(row, maxWidth) : row);
  }

  const folded = sorted.length - PANEL_MAX_ROWS;
  if (folded > 0) lines.push(`另有 ${folded} 条排队`);
  const queued = sorted.filter((task) => task.status === "queued").length;
  lines.push(`活跃 ${sorted.length} · 排队 ${queued} · 任务执行完即可清理 · 合计=保留期内列表费用（历史不累计）`);
  // 票 08：最近完成回显（footer 之后一行小字，不挤占活跃行；最近窗口为空则不出行）
  if (recent.length > 0) {
    lines.push(`最近完成 ${recent.length} 条 · 完成即移出活跃列表（详情见 farm_status）`);
  }
  return lines;
}
