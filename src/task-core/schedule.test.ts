// src/task-core/schedule.test.ts
// 只断言外部行为：parseSchedule 的判别联合产物（kind / 数值 Set 成员）与
// nextFire 的输出 / 抛错，不测内部实现。
// 时间断言一律用 new Date(y, m, d, ...)（本地时区）构造期望值，与实现同用
// 本地时间，测试不依赖运行环境时区。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_SCAN_MS,
  nextFire,
  parseSchedule,
  type CronSchedule,
  type ScheduleInput,
} from "./schedule.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地时区时间戳（epoch ms）构造器 */
function at(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return new Date(y, mo, d, h, mi, s).getTime();
}

/** 0..n 数值集合 */
function rangeSet(n: number): Set<number> {
  return new Set(Array.from({ length: n + 1 }, (_, i) => i));
}

/**
 * 测试助手：解析 cron 表达式并窄化判别联合——parseSchedule 返回 ParsedSchedule
 * 联合，cron 分支才带 minutes/hours（kind 窄化后在多语句测试体里不复用）。
 */
function parseCron(expr: string): CronSchedule {
  const s = parseSchedule({ mode: "cron", cron: expr });
  if (s.kind !== "cron") {
    throw new Error(`unreachable: ${expr} 应解析为 cron`);
  }
  return s;
}

/** 断言抛 RangeError 且消息带指定字段名 */
function throwsRange(fn: () => unknown, fieldRe: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof RangeError, `expected RangeError, got ${String(err)}`);
    assert.match(String((err as Error).message), fieldRe);
    return true;
  });
}

// ---------- parseSchedule：三形态解析 ----------

test("parseSchedule 三形态判别联合：kind 字段区分 once/interval/cron", () => {
  assert.equal(parseSchedule({ mode: "once", onceAt: 1 }).kind, "once");
  assert.equal(parseSchedule({ mode: "interval", intervalSecs: 60 }).kind, "interval");
  assert.equal(parseCron("* * * * *").kind, "cron");
});

test("parseSchedule once：正常解析", () => {
  assert.deepEqual(parseSchedule({ mode: "once", onceAt: 1234567890 }), {
    kind: "once",
    at: 1234567890,
  });
});

test("parseSchedule once 边界：onceAt=0（永不触发）在 parse 阶段抛 RangeError", () => {
  throwsRange(() => parseSchedule({ mode: "once", onceAt: 0 }), /onceAt/);
});

test("parseSchedule once 非法字段抛 RangeError（带字段名 onceAt）", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ mode: "once" }, /onceAt/], // 缺 onceAt
    [{ mode: "once", onceAt: -1 }, /onceAt/],
    [{ mode: "once", onceAt: NaN }, /onceAt/],
    [{ mode: "once", onceAt: Infinity }, /onceAt/],
    [{ mode: "once", onceAt: "123" }, /onceAt/], // 非数字
  ];
  for (const [input, re] of cases) {
    throwsRange(() => parseSchedule(input as ScheduleInput), re);
  }
});

test("parseSchedule interval：正常解析", () => {
  assert.deepEqual(parseSchedule({ mode: "interval", intervalSecs: 300 }), {
    kind: "interval",
    intervalSecs: 300,
  });
});

test("parseSchedule interval 边界：intervalSecs=1 合法（下界）", () => {
  assert.deepEqual(parseSchedule({ mode: "interval", intervalSecs: 1 }), {
    kind: "interval",
    intervalSecs: 1,
  });
});

test("parseSchedule interval 非法字段抛 RangeError（带字段名 intervalSecs）", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ mode: "interval" }, /intervalSecs/], // 缺 intervalSecs
    [{ mode: "interval", intervalSecs: 0 }, /intervalSecs/],
    [{ mode: "interval", intervalSecs: -60 }, /intervalSecs/],
    [{ mode: "interval", intervalSecs: 1.5 }, /intervalSecs/], // 非整数
    [{ mode: "interval", intervalSecs: NaN }, /intervalSecs/],
    [{ mode: "interval", intervalSecs: "60" }, /intervalSecs/], // 非数字
  ];
  for (const [input, re] of cases) {
    throwsRange(() => parseSchedule(input as ScheduleInput), re);
  }
});

test("parseSchedule 忽略运行时字段（lastRun/nextRun/firedTaskIds 只读不写）", () => {
  const s = parseSchedule({
    mode: "interval",
    intervalSecs: 60,
    lastRun: 111,
    nextRun: 222,
    firedTaskIds: ["t1"],
  });
  assert.deepEqual(s, { kind: "interval", intervalSecs: 60 });
});

test("parseSchedule 未知 mode / 缺 mode 抛 RangeError（带字段名 mode）", () => {
  throwsRange(() => parseSchedule({ mode: "daily" }), /mode/);
  throwsRange(() => parseSchedule({} as ScheduleInput), /mode/);
});

test("parseSchedule 非对象入参抛 TypeError", () => {
  // @ts-expect-error 防御性运行时行为（JS 调用方可能传入非对象）
  assert.throws(() => parseSchedule(null), TypeError);
  // @ts-expect-error 同上
  assert.throws(() => parseSchedule("once"), TypeError);
});

// ---------- parseSchedule：cron 正常与边界 ----------

test("parseSchedule cron 全通配 \"* * * * *\"：分钟 0-59 / 小时 0-23", () => {
  const s = parseCron("* * * * *");
  assert.deepEqual(s, { kind: "cron", minutes: rangeSet(59), hours: rangeSet(23) });
});

test("parseSchedule cron */n 步进与区间", () => {
  const s = parseCron("*/15 9-17 * * *");
  assert.deepEqual(s.minutes, new Set([0, 15, 30, 45]));
  assert.deepEqual(s.hours, new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]));
});

test("parseSchedule cron 逗号列表", () => {
  const s = parseCron("1,5,10 8 * * *");
  assert.deepEqual(s.minutes, new Set([1, 5, 10]));
  assert.deepEqual(s.hours, new Set([8]));
});

test("parseSchedule cron range/n 区间步进", () => {
  const s = parseCron("10-15/2 7 * * *");
  assert.deepEqual(s.minutes, new Set([10, 12, 14]));
  assert.deepEqual(s.hours, new Set([7]));
});

test("parseSchedule cron 混合段（数字+区间+步进）取并集", () => {
  const s = parseCron("1,5-7,*/10 0 * * *");
  assert.deepEqual(s.minutes, new Set([0, 1, 5, 6, 7, 10, 20, 30, 40, 50]));
  assert.deepEqual(s.hours, new Set([0]));
});

test("parseSchedule cron 前导零", () => {
  const s = parseCron("05 09 * * *");
  assert.deepEqual(s.minutes, new Set([5]));
  assert.deepEqual(s.hours, new Set([9]));
  const s2 = parseCron("00-05 00 * * *");
  assert.deepEqual(s2.minutes, rangeSet(5));
  assert.deepEqual(s2.hours, new Set([0]));
});

test("parseSchedule cron 产物是数值 Set（非字符串）", () => {
  const s = parseCron("*/15 9-17 * * *");
  assert.ok(s.minutes instanceof Set);
  assert.ok(s.hours instanceof Set);
  for (const v of s.minutes) assert.equal(typeof v, "number");
  for (const v of s.hours) assert.equal(typeof v, "number");
});

// ---------- parseSchedule：cron 抛错全表（带字段名） ----------

test("parseSchedule cron 字段数错误抛 RangeError（带字段名 cron）", () => {
  throwsRange(() => parseCron("30 14 * *"), /cron/); // 4 字段
  throwsRange(() => parseCron("30 14 * * * *"), /cron/); // 6 字段
  throwsRange(() => parseCron(""), /cron/); // 空表达式
});

test("parseSchedule cron dom/mon/dow 非 `*` 抛 RangeError（带对应字段名）", () => {
  throwsRange(() => parseCron("30 14 1 * *"), /dom/);
  throwsRange(() => parseCron("30 14 */2 * *"), /dom/);
  throwsRange(() => parseCron("30 14 * 5 *"), /mon/);
  throwsRange(() => parseCron("30 14 * * 1"), /dow/);
});

test("parseSchedule cron min/hour 越界抛 RangeError（带对应字段名）", () => {
  throwsRange(() => parseCron("60 * * * *"), /min/);
  throwsRange(() => parseCron("0-60 * * * *"), /min/);
  throwsRange(() => parseCron("* 24 * * *"), /hour/);
  throwsRange(() => parseCron("* 0-24 * * *"), /hour/);
});

test("parseSchedule cron 倒序区间抛 RangeError（带对应字段名）", () => {
  throwsRange(() => parseCron("10-5 * * * *"), /min/);
  throwsRange(() => parseCron("* 5-0 * * *"), /hour/);
});

test("parseSchedule cron 空段抛 RangeError（带对应字段名）", () => {
  throwsRange(() => parseCron("1,,2 * * * *"), /min/);
  throwsRange(() => parseCron(",1 * * * *"), /min/);
  throwsRange(() => parseCron("1, * * * *"), /min/);
});

test("parseSchedule cron 非整数/零 step 抛 RangeError（带对应字段名）", () => {
  throwsRange(() => parseCron("*/2.5 * * * *"), /min/);
  throwsRange(() => parseCron("1-10/2.5 * * * *"), /min/);
  throwsRange(() => parseCron("*/0 * * * *"), /min/);
});

test("parseSchedule cron 单值带步进 N/n 不支持（带对应字段名）", () => {
  throwsRange(() => parseCron("5/2 * * * *"), /min/);
});

test("parseSchedule cron 垃圾语法抛 RangeError（带对应字段名）", () => {
  throwsRange(() => parseCron("a * * * *"), /min/);
  throwsRange(() => parseCron("1- * * * *"), /min/);
  throwsRange(() => parseCron("-1 * * * *"), /min/);
  throwsRange(() => parseCron("*/ * * * *"), /min/);
  throwsRange(() => parseCron("1-2-3 * * * *"), /min/);
});

test("parseSchedule cron 缺 cron 字段抛 RangeError（带字段名 cron）", () => {
  throwsRange(() => parseSchedule({ mode: "cron" }), /cron/);
});

// ---------- nextFire：once / interval ----------

test("nextFire once：未来时间戳直接返回", () => {
  const s = parseSchedule({ mode: "once", onceAt: 2000 });
  assert.equal(nextFire(s, 1000), 2000);
});

test("nextFire once：等于 from 不触发、过去抛 RangeError（严格未来/无匹配）", () => {
  const s = parseSchedule({ mode: "once", onceAt: 1000 });
  assert.throws(() => nextFire(s, 1000), RangeError); // at === from
  assert.throws(() => nextFire(s, 1001), RangeError); // 过去
});

test("nextFire interval：from + intervalSecs*1000（纯偏移）", () => {
  assert.equal(nextFire({ kind: "interval", intervalSecs: 300 }, 1000), 301_000);
  assert.equal(nextFire({ kind: "interval", intervalSecs: 1 }, 1000), 2000);
});

test("nextFire interval：跨日照常（不折日历，重叠语义归 M6）", () => {
  const from = at(2026, 0, 1, 23, 59, 30);
  assert.equal(nextFire({ kind: "interval", intervalSecs: 60 }, from), from + 60_000);
});

// ---------- nextFire：cron ----------

test("nextFire cron：基础（同日未来命中）", () => {
  const s = parseCron("30 14 * * *");
  assert.equal(nextFire(s, at(2026, 0, 1, 12, 0)), at(2026, 0, 1, 14, 30));
});

test("nextFire cron：分钟粒度线性扫描（跳过不命中分钟）", () => {
  const s = parseCron("*/15 * * * *");
  assert.equal(nextFire(s, at(2026, 0, 1, 12, 7)), at(2026, 0, 1, 12, 15));
  assert.equal(nextFire(s, at(2026, 0, 1, 12, 46)), at(2026, 0, 1, 13, 0));
});

test("nextFire cron：严格未来——from 恰在命中分钟也不触发", () => {
  const s = parseCron("34 12 * * *");
  assert.equal(nextFire(s, at(2026, 0, 1, 12, 34, 0)), at(2026, 0, 2, 12, 34));
});

test("nextFire cron：分钟粒度——命中分钟已过半不回头", () => {
  const s = parseCron("0 12 * * *");
  assert.equal(nextFire(s, at(2026, 0, 1, 12, 0, 30)), at(2026, 0, 2, 12, 0));
});

test("nextFire cron：全通配每分钟触发 → from 下一分钟", () => {
  const s = parseCron("* * * * *");
  assert.equal(nextFire(s, at(2026, 0, 1, 12, 0)), at(2026, 0, 1, 12, 1));
  assert.equal(nextFire(s, at(2026, 0, 1, 12, 0, 30)), at(2026, 0, 1, 12, 1));
});

test("nextFire cron：跨日", () => {
  const s = parseCron("0 1 * * *");
  assert.equal(nextFire(s, at(2026, 0, 1, 23, 30)), at(2026, 0, 2, 1, 0));
});

test("nextFire cron：跨年", () => {
  const s = parseCron("30 1 * * *");
  assert.equal(nextFire(s, at(2026, 11, 31, 2, 0)), at(2027, 0, 1, 1, 30));
});

test("nextFire cron：小时步进", () => {
  const s = parseCron("0 */6 * * *");
  assert.equal(nextFire(s, at(2026, 0, 1, 9, 30)), at(2026, 0, 1, 12, 0));
});

test("nextFire cron：逗号列表命中", () => {
  const s = parseCron("10,40 9-10 * * *");
  assert.equal(nextFire(s, at(2026, 0, 1, 9, 20)), at(2026, 0, 1, 9, 40));
});

test("nextFire cron：超扫描上限无匹配抛 RangeError", () => {
  const s = parseCron("30 14 * * *");
  // 下一命中 14:30 距 from 2.5 小时，窗口只给 1 小时 → 无匹配抛错
  assert.throws(() => nextFire(s, at(2026, 0, 1, 12, 0), 3600_000), RangeError);
});

test("nextFire cron：扫描窗口含边界（命中恰在 from+maxScanMs 返回，差 1ms 抛错）", () => {
  const s = parseCron("0 13 * * *");
  const from = at(2026, 0, 1, 12, 0);
  assert.equal(nextFire(s, from, 3600_000), at(2026, 0, 1, 13, 0));
  assert.throws(() => nextFire(s, from, 3599_999), RangeError);
});

test("nextFire cron：默认扫描上限 = 366 天", () => {
  assert.equal(DEFAULT_MAX_SCAN_MS, 366 * DAY_MS);
  const s = parseCron("30 14 * * *");
  // 任何合法 cron 每日必命中，默认窗口内必有解
  assert.equal(nextFire(s, at(2026, 0, 1, 14, 30)), at(2026, 0, 2, 14, 30));
});

// ---------- nextFire：入参防御 + 三形态 roundtrip ----------

test("nextFire 入参防御：fromMs / maxScanMs 非法抛 TypeError", () => {
  const s = parseSchedule({ mode: "interval", intervalSecs: 60 });
  assert.throws(() => nextFire(s, NaN), TypeError);
  // @ts-expect-error 防御性运行时行为
  assert.throws(() => nextFire(s, "1000"), TypeError);
  assert.throws(() => nextFire(s, 1000, -1), TypeError);
  assert.throws(() => nextFire(s, 1000, NaN), TypeError);
});

test("parseSchedule → nextFire 三形态 roundtrip", () => {
  const once = parseSchedule({ mode: "once", onceAt: at(2026, 1, 1, 8, 0) });
  assert.equal(nextFire(once, at(2026, 0, 1)), at(2026, 1, 1, 8, 0));

  const interval = parseSchedule({ mode: "interval", intervalSecs: 3600 });
  assert.equal(nextFire(interval, at(2026, 0, 1, 12, 0)), at(2026, 0, 1, 13, 0));

  const cron = parseCron("0 9 * * *");
  assert.equal(nextFire(cron, at(2026, 0, 1, 8, 0)), at(2026, 0, 1, 9, 0));
});
