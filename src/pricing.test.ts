// src/pricing.test.ts
// 票 04 单测（node:test）：pricing 纯模块 token→金额换算。全零 I/O 纯函数，直接
// 经公开 API 断言，禁源码文本断言。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRICING_TABLE,
  costAmount,
  currencySymbol,
  formatCost,
  parsePricingTable,
  resolvePricing,
} from "./pricing.ts";
import type { PricingTable } from "./pricing.ts";

// ── 默认表形状 ────────────────────────────────────────────────────────────

test("DEFAULT_PRICING_TABLE 含占位模型键 your-vendor/your-model（用户经 pricing.json 校准）", () => {
  assert.equal(DEFAULT_PRICING_TABLE.currency, "USD");
  assert.equal(DEFAULT_PRICING_TABLE.per, 1_000_000);
  assert.deepEqual(DEFAULT_PRICING_TABLE.models["your-vendor/your-model"], {
    input: 0.5,
    output: 2.0,
  });
});

// ── parsePricingTable ─────────────────────────────────────────────────────

test("parsePricingTable 合法 JSON 返回价目表", () => {
  const t = parsePricingTable(
    '{"currency":"USD","per":1000000,"models":{"m":{"input":1,"output":2}}}',
  );
  assert.deepEqual(t, {
    currency: "USD",
    per: 1_000_000,
    models: { m: { input: 1, output: 2 } },
  });
});

test("parsePricingTable 非法 JSON → null", () => {
  assert.equal(parsePricingTable("{not json"), null);
});

test("parsePricingTable 缺 currency → null", () => {
  assert.equal(parsePricingTable('{"per":1000000,"models":{}}'), null);
});

test("parsePricingTable currency 非 string → null", () => {
  assert.equal(parsePricingTable('{"currency":123,"per":1000000,"models":{}}'), null);
});

test("parsePricingTable per 非正（0/负数）→ null", () => {
  assert.equal(parsePricingTable('{"currency":"USD","per":0,"models":{}}'), null);
  assert.equal(parsePricingTable('{"currency":"USD","per":-1,"models":{}}'), null);
});

test("parsePricingTable per 非有限数（字符串）→ null", () => {
  assert.equal(
    parsePricingTable('{"currency":"USD","per":"1000000","models":{}}'),
    null,
  );
});

test("parsePricingTable models 非对象（数组/字符串）→ null", () => {
  assert.equal(parsePricingTable('{"currency":"USD","per":1000000,"models":[]}'), null);
  assert.equal(parsePricingTable('{"currency":"USD","per":1000000,"models":"x"}'), null);
});

test("parsePricingTable 单价非有限数（字符串/null）→ null", () => {
  assert.equal(
    parsePricingTable(
      '{"currency":"USD","per":1000000,"models":{"m":{"input":"1","output":2}}}',
    ),
    null,
  );
  assert.equal(
    parsePricingTable(
      '{"currency":"USD","per":1000000,"models":{"m":{"input":1,"output":null}}}',
    ),
    null,
  );
});

test("parsePricingTable 单价非对象（数组）→ null", () => {
  assert.equal(
    parsePricingTable('{"currency":"USD","per":1000000,"models":{"m":[1,2]}}'),
    null,
  );
});

test('parsePricingTable "*" 键合法透传', () => {
  const t = parsePricingTable(
    '{"currency":"USD","per":1000000,"models":{"*":{"input":0.5,"output":0.5}}}',
  );
  assert.deepEqual(t?.models["*"], { input: 0.5, output: 0.5 });
});

// ── resolvePricing ────────────────────────────────────────────────────────

test("resolvePricing 精确命中返回对应单价", () => {
  assert.deepEqual(resolvePricing(DEFAULT_PRICING_TABLE, "gpt-4o"), {
    input: 2.5,
    output: 10,
  });
});

test('resolvePricing "*" 兜底', () => {
  const t: PricingTable = {
    currency: "USD",
    per: 1000,
    models: { "*": { input: 0.5, output: 0.5 } },
  };
  assert.deepEqual(resolvePricing(t, "unknown-model"), { input: 0.5, output: 0.5 });
});

test("resolvePricing 未知且无兜底 → null", () => {
  const t: PricingTable = {
    currency: "USD",
    per: 1000,
    models: { m: { input: 1, output: 2 } },
  };
  assert.equal(resolvePricing(t, "unknown-model"), null);
});

// ── costAmount ────────────────────────────────────────────────────────────

test("costAmount 公式正确（inputTokens/per*input + outputTokens/per*output）", () => {
  const t: PricingTable = {
    currency: "USD",
    per: 1000,
    models: { m: { input: 1, output: 2 } },
  };
  // (1000/1000)*1 + (2000/1000)*2 = 1 + 4 = 5
  assert.equal(costAmount(t, "m", 1000, 2000), 5);
});

test("costAmount input/output 分向价不同", () => {
  const t: PricingTable = {
    currency: "USD",
    per: 1000,
    models: { m: { input: 1, output: 2 } },
  };
  // 同 token 数下 input 价 1、output 价 2 → 1 + 2 = 3
  assert.equal(costAmount(t, "m", 1000, 1000), 3);
});

test("costAmount 未知模型 → null", () => {
  assert.equal(costAmount(DEFAULT_PRICING_TABLE, "unknown-model", 1000, 1000), null);
});

test("costAmount token 非有限数按 0 计", () => {
  const t: PricingTable = {
    currency: "USD",
    per: 1000,
    models: { m: { input: 1, output: 2 } },
  };
  assert.equal(costAmount(t, "m", Infinity, NaN), 0);
});

// ── formatCost ────────────────────────────────────────────────────────────

test('formatCost 固定 4 位 → "$0.0123"', () => {
  assert.equal(formatCost(0.0123456, "USD"), "$0.0123");
});

test("formatCost CNY 符号", () => {
  assert.equal(formatCost(0.0123, "CNY"), "¥0.0123");
});

test("formatCost 未知币种前缀 currency + 空格", () => {
  assert.equal(formatCost(0.0123, "EUR"), "EUR 0.0123");
});

// ── currencySymbol ────────────────────────────────────────────────────────

test("currencySymbol USD/CNY/缺省前缀", () => {
  assert.equal(currencySymbol("USD"), "$");
  assert.equal(currencySymbol("CNY"), "¥");
  assert.equal(currencySymbol("EUR"), "EUR ");
});
