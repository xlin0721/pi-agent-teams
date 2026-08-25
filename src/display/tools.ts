// src/display/tools.ts
// 工具事件摘要 + usage 提取（票 04 R#7 拆分自 render-core.ts）。零 node: 依赖。

import { collapseWhitespace, stripAnsiText, truncateTo } from "./primitives.ts";
import type { UsageInfo } from "./types.ts";

/** 工具 args/result 摘要截断长度 */
export const TOOL_SUMMARY_MAX = 200;

// ── 工具事件摘要 ──────────────────────────────────────────────────────────

/** content 数组 [{type:"text",text}] → 拼接文本（容错：非数组/缺字段 → ""）。 */
export function extractTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] !== "text") continue;
    const t = b["text"];
    if (typeof t === "string") out += t;
  }
  return out;
}

/** content 数组 [{type:"thinking",text}] → 拼接（容错同 extractTextBlocks）。 */
export function extractThinkingBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] !== "thinking") continue;
    const t = b["text"];
    if (typeof t === "string") out += t;
  }
  return out;
}

/** 工具 args → 单行摘要（bash 取 command 字段，其余 JSON 化；剥 ANSI + 折叠空白 + 截 200）。 */
export function formatToolArgs(args: unknown): string {
  let raw = "";
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const cmd = (args as Record<string, unknown>)["command"];
    if (typeof cmd === "string") raw = cmd;
  }
  if (raw === "") {
    try {
      raw = JSON.stringify(args);
    } catch {
      return "";
    }
  }
  return truncateTo(collapseWhitespace(stripAnsiText(raw)), TOOL_SUMMARY_MAX);
}

/** 工具 result → 单行摘要（content text 块优先，缺则 JSON 化；剥 ANSI + 折叠 + 截 200）。 */
export function formatToolResult(result: unknown): string {
  if (result !== null && typeof result === "object") {
    const text = extractTextBlocks((result as Record<string, unknown>)["content"]);
    const cleaned = collapseWhitespace(stripAnsiText(text));
    if (cleaned.trim() !== "") return truncateTo(cleaned, TOOL_SUMMARY_MAX);
    try {
      return truncateTo(collapseWhitespace(JSON.stringify(result)), TOOL_SUMMARY_MAX);
    } catch {
      return "";
    }
  }
  return truncateTo(collapseWhitespace(stripAnsiText(String(result))), TOOL_SUMMARY_MAX);
}

/** usage 从 message 字段提取（无独立事件）：totalTokens 缺则 input+output 兜底。 */
export function extractUsage(message: unknown): UsageInfo | null {
  if (message === null || typeof message !== "object") return null;
  const u = (message as Record<string, unknown>)["usage"];
  if (u === null || typeof u !== "object") return null;
  const uu = u as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const input = num(uu["input"]);
  const output = num(uu["output"]);
  let total = num(uu["totalTokens"]);
  if (total === null && input !== null && output !== null) total = input + output;
  return { input: input ?? 0, output: output ?? 0, totalTokens: total };
}

/** queue_update.steering 容错计数（spike §Q：缺失/非数组按空，非字符串元素跳过）。 */
export function countStringArray(v: unknown): number {
  if (!Array.isArray(v)) return 0;
  let n = 0;
  for (const item of v) if (typeof item === "string") n++;
  return n;
}

