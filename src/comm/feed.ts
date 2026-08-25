// src/comm/feed.ts
// comm 面板聚合视图（票 01）：5 列台账 + usage + 投递态 + 计数行，纯渲染零副作用。
// 票 07 面板（setWidget）消费；本模块只 import node 内置之外的零依赖相对 .ts：
//   - probe.ts 三个导出（FARM_STATUS_LABELS / durationText / sortTasksForDisplay）
//     ——probe.ts 的 padCell/spawnRole 是私有不可 import，feed 内本地 padCell（列宽
//     与 renderFarmTable 逐字对齐：8/12/8/8）。
//   - presence.ts 的 isAlive（存活计数）。
//   - steer.ts 的 pickLatest（投递态列取该 pane 最新消息）。

import type { TaskRecord } from "../task-core/store.ts";
import type { UsageSidecar } from "../task-core/queue.ts";
import { pickLatest, type InboxMessage } from "../task-core/steer.ts";
import { FARM_STATUS_LABELS, durationText, sortTasksForDisplay } from "../probe.ts";
import { isAlive, type Presence } from "./presence.ts";
import { costAmount, DEFAULT_PRICING_TABLE, formatCost } from "../pricing.ts";
import type { PricingTable } from "../pricing.ts";

export interface FeedOptions {
  /** 时间锚（耗时/存活/投递态）；缺省 Date.now() */
  now?: number;
  /** BE#5：面板最多显示的任务行数（recent N）；缺省 50；<=0 = 不限制 */
  recentN?: number;
  /** FE#4：行宽上限——usage/投递态列右向截断（省略号）；缺省 = 不截断 */
  maxWidth?: number;
  /** 价目表（票 05）；缺省 = DEFAULT_PRICING_TABLE，向后兼容现有测试 */
  pricing?: PricingTable;
}

/** 前 5 列复用 renderFarmTable 语义（列宽/标签/耗时口径一致）+ usage/投递态两列。 */
const HEADER = "taskId   role         status   attempts 耗时 usage/费用 投递";

/** 本地 padCell（probe.ts padCell 为私有；列宽与 renderFarmTable 逐字对齐）。 */
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

/** 前 5 列（与 renderFarmTable 行逐字同宽：8/12/8/8 + durationText 尾列）。 */
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
 * 面板聚合视图：表头 + 任务行（createdAt 升序，recent N 取尾部最新）+ 计数行。
 * 返回 string[]（setWidget 行数组）。纯函数：不改任何输入。
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
  const sorted = sortTasksForDisplay(tasks);
  const recentN = opts.recentN ?? 50;
  const shown = recentN > 0 && sorted.length > recentN ? sorted.slice(-recentN) : sorted;
  const aliveCount = presence.filter((p) => isAlive(p, now)).length;
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

  let countLine = `共 ${tasks.length} 个任务 · 存活 ${aliveCount} · 会话保留 7 天`;
  if (recentN > 0 && sorted.length > recentN) {
    countLine += `（显示最近 ${shown.length}/${tasks.length}）`;
  }
  // 合计（票 05）：遍历全部 tasks，costSourceFor + costAmount 求和（unknown/null 排除）；
  // 无可计任务不追加「合计」段。
  let total = 0;
  let hasTotal = false;
  for (const task of tasks) {
    const source = costSourceFor(task, usageMap.get(task.taskId));
    if (source === null) continue;
    const amount = costAmount(pricing, source.model, source.inputTokens, source.outputTokens);
    if (amount === null) continue;
    total += amount;
    hasTotal = true;
  }
  if (hasTotal) {
    countLine += ` · 合计 ${formatCost(total, pricing.currency)}`;
  }
  lines.push(countLine);
  return lines;
}
