// src/pricing.ts
// 票 04 — pricing 纯模块（token → 金额换算，成本面板数据源）。
// 零 I/O、零 pi SDK import、零 node: import、零第三方：纯计算，被 feed.ts（票 05）
// 与 index.ts（票 05）消费。换算层放 task-core 之外（PRD §13.3「价格换算放
// index.ts 层/事后统计」既定边界）：task-core 零价目表。
//
// node 22 type-stripping 约束：禁 enum/namespace/构造器参数属性（本文件均未使用）。

/** 每 `per` tokens 的金额（input = 输入单价、output = 输出单价）。 */
export interface DirectionPricing {
  input: number;
  output: number;
}

/** 价目表：币种 + 每 `per` tokens 计价基数 + model 键 → 双向单价。 */
export interface PricingTable {
  currency: string;
  per: number;
  models: Record<string, DirectionPricing>;
}

// 默认价目表：所有 model 键单价均为占位，用户经 ~/.pi-agent-teams/pricing.json 校准
// （pi-agent-teams 只读不写，见 PRD §13.3）。model 键为通用占位示例，
// 真实模型与价格由用户经 pricing.json 校准。
export const DEFAULT_PRICING_TABLE: PricingTable = {
  currency: "USD",
  per: 1_000_000,
  models: {
    // 占位示例，用户经 pricing.json 校准（替换为自己的模型键）
    "your-vendor/your-model": { input: 0.5, output: 2.0 },
    "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
    "claude-opus-4-1": { input: 15.0, output: 75.0 },
    "claude-haiku-4-5": { input: 0.8, output: 4.0 },
    "gpt-4.1": { input: 2.0, output: 8.0 },
    "gpt-4o": { input: 2.5, output: 10.0 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
  },
};

/** 严格有限数判定（不隐式转换：字符串/NaN/Infinity 均非有限数）。 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * JSON 解析 + 形状校验（宁缺毋错）：
 * currency 非 string / per 非正有限数 / models 非对象 / 单价非有限数 → null。
 * `"*"` 键作为普通 model 键合法透传（兜底语义在 resolvePricing 消费）。
 */
export function parsePricingTable(raw: string): PricingTable | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  const currency = obj.currency;
  const per = obj.per;
  const models = obj.models;
  if (typeof currency !== "string") return null;
  if (!isFiniteNumber(per) || per <= 0) return null;
  if (typeof models !== "object" || models === null || Array.isArray(models)) return null;

  const parsed: Record<string, DirectionPricing> = {};
  const modelsRecord = models as Record<string, unknown>;
  for (const [key, value] of Object.entries(modelsRecord)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const d = value as Record<string, unknown>;
    const input = d.input;
    const output = d.output;
    if (!isFiniteNumber(input) || !isFiniteNumber(output)) return null;
    parsed[key] = { input, output };
  }
  return { currency, per, models: parsed };
}

/** 精确匹配 → `"*"` 兜底 → null。 */
export function resolvePricing(table: PricingTable, model: string): DirectionPricing | null {
  const exact = table.models[model];
  if (exact !== undefined) return exact;
  const fallback = table.models["*"];
  if (fallback !== undefined) return fallback;
  return null;
}

/**
 * 金额 = inputTokens/per*input + outputTokens/per*output。
 * 未知模型 → null；token 非有限数按 0 计。
 */
export function costAmount(
  table: PricingTable,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = resolvePricing(table, model);
  if (pricing === null) return null;
  const inTokens = Number.isFinite(inputTokens) ? inputTokens : 0;
  const outTokens = Number.isFinite(outputTokens) ? outputTokens : 0;
  return (inTokens / table.per) * pricing.input + (outTokens / table.per) * pricing.output;
}

/** currencySymbol(currency) + amount.toFixed(4)（固定 4 位小数）。 */
export function formatCost(amount: number, currency: string): string {
  return currencySymbol(currency) + amount.toFixed(4);
}

/** USD→"$"、CNY→"¥"，缺省 `currency + " "` 前缀。 */
export function currencySymbol(currency: string): string {
  if (currency === "USD") return "$";
  if (currency === "CNY") return "¥";
  return currency + " ";
}
