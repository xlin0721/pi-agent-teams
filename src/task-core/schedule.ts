// src/task-core/schedule.ts
// 调度纯解析器：once / interval / cron 三形态解析 + 下次触发计算（零依赖、零 import）
//
// 依据：.scratch/m1b-task-core/issues/06-schedule.md（已批准方案）——
//   - parseSchedule(input) → ParsedSchedule 判别联合；非法 → RangeError（带字段名）；
//     onceAt ≤ 0（含 0 / 负数）或 NaN 在 parse 阶段即拒绝（"永不触发"配置不入库）
//   - cron 范围 pin：5 字段（min hour dom mon dow）；min/hour 支持 `*` / 数字 /
//     逗号 / 区间 / 步进（`*/n` 与 `range/n`；`N/n` 不支持）；dom/mon/dow 仅 `*`；
//     倒序区间 / 空段 / 非整数 step / 越界 → 抛错；产物 min/hour 数值 Set
//   - nextFire(s, fromMs, maxScanMs=366d)：严格未来（from 本身不触发）；
//     cron 分钟级线性扫描（本地时间，超 maxScanMs 抛错）；onceAt 过去 → 抛错
//     （与"无匹配抛错"同语义）；interval = from + intervalSecs*1000（intervalSecs ≥ 1）
//   - lastRun / nextRun / firedTaskIds 本票只读不写（M5 ticker 归属）
// TZ / DST / interval 重叠语义不实现（M6 台账 B10）。

/** 366 天（nextFire 默认扫描上限） */
export const DEFAULT_MAX_SCAN_MS = 366 * 24 * 60 * 60 * 1000;

/** parseSchedule 入参 = §13.3 payload.schedule 的配置子集，容忍运行时字段 */
export interface ScheduleInput {
  /** "once" | "interval" | "cron"（运行时校验，输入来自 JSON） */
  mode: string;
  cron?: string;
  intervalSecs?: number;
  onceAt?: number;
  // 运行时字段（M5 ticker 归属）：本票只读不写，解析时忽略
  lastRun?: number;
  nextRun?: number;
  firedTaskIds?: string[];
}

export interface OnceSchedule {
  kind: "once";
  /** 绝对触发时间戳（epoch ms） */
  at: number;
}

export interface IntervalSchedule {
  kind: "interval";
  /** 间隔秒数，≥ 1（parse 校验） */
  intervalSecs: number;
}

export interface CronSchedule {
  kind: "cron";
  /** 命中分钟 0-59（数值 Set） */
  minutes: Set<number>;
  /** 命中小时 0-23（数值 Set） */
  hours: Set<number>;
}

/** 判别联合：parseSchedule 的产物、nextFire 的入参 */
export type ParsedSchedule = OnceSchedule | IntervalSchedule | CronSchedule;

/**
 * 解析 once / interval / cron 三形态调度配置。
 * 非法配置抛 RangeError，消息带字段名（schedule.mode / schedule.onceAt /
 * schedule.intervalSecs / schedule.cron.<field>）；非对象入参抛 TypeError。
 * onceAt 必须是 > 0 的有限数字：≤ 0（含 0 与负数）或 NaN 直接拒绝，
 * 不留给 nextFire 才暴露。
 */
export function parseSchedule(input: ScheduleInput): ParsedSchedule {
  if (input === null || typeof input !== "object") {
    throw new TypeError("parseSchedule: input must be an object");
  }
  switch (input.mode) {
    case "once": {
      const at = input.onceAt;
      if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) {
        throw new RangeError(
          "schedule.onceAt: must be a positive finite number (epoch ms)",
        );
      }
      return { kind: "once", at };
    }
    case "interval": {
      const intervalSecs = input.intervalSecs;
      if (
        typeof intervalSecs !== "number" ||
        !Number.isInteger(intervalSecs) ||
        intervalSecs < 1
      ) {
        throw new RangeError("schedule.intervalSecs: must be an integer >= 1");
      }
      return { kind: "interval", intervalSecs };
    }
    case "cron": {
      const expr = input.cron;
      if (typeof expr !== "string") {
        throw new RangeError("schedule.cron: must be a string");
      }
      const { minutes, hours } = parseCron(expr);
      return { kind: "cron", minutes, hours };
    }
    default:
      throw new RangeError(
        `schedule.mode: unknown mode ${JSON.stringify(input.mode)} (expected once|interval|cron)`,
      );
  }
}

/**
 * 计算下一次触发时间（epoch ms）。
 * - once：at 严格大于 fromMs 时直接返回；否则抛 RangeError（过去即"无匹配"）。
 * - interval：fromMs + intervalSecs*1000（parse 已保证 intervalSecs ≥ 1，恒严格未来）。
 * - cron：本地时间、分钟粒度线性扫描——从 fromMs 所在分钟的下一分钟起逐分钟
 *   检查 hh:mm 是否命中，命中即返回；扫过 fromMs + maxScanMs 仍无命中抛 RangeError。
 */
export function nextFire(
  s: ParsedSchedule,
  fromMs: number,
  maxScanMs: number = DEFAULT_MAX_SCAN_MS,
): number {
  if (typeof fromMs !== "number" || !Number.isFinite(fromMs)) {
    throw new TypeError("nextFire: fromMs must be a finite number (epoch ms)");
  }
  if (
    typeof maxScanMs !== "number" ||
    !Number.isFinite(maxScanMs) ||
    maxScanMs < 0
  ) {
    throw new TypeError("nextFire: maxScanMs must be a non-negative finite number");
  }
  switch (s.kind) {
    case "once":
      if (s.at <= fromMs) {
        throw new RangeError(
          `schedule.once: fire time ${s.at} is not strictly after from ${fromMs}`,
        );
      }
      return s.at;

    case "interval":
      return fromMs + s.intervalSecs * 1000;

    case "cron": {
      const limit = fromMs + maxScanMs;
      // 严格未来：from 所在分钟（含更早命中）不触发，从下一分钟开始扫。
      let minute = Math.floor(fromMs / 60_000) + 1;
      for (;;) {
        const ms = minute * 60_000;
        if (ms > limit) {
          throw new RangeError(
            `schedule.cron: no fire time within ${maxScanMs}ms scan window from ${fromMs}`,
          );
        }
        const d = new Date(ms); // 本地时间
        if (s.hours.has(d.getHours()) && s.minutes.has(d.getMinutes())) {
          return ms;
        }
        minute += 1;
      }
    }

    default:
      throw new TypeError("nextFire: unknown schedule kind");
  }
}

// ---------- cron 解析（内部） ----------

function parseCron(expr: string): { minutes: Set<number>; hours: Set<number> } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new RangeError(
      `schedule.cron: expected 5 whitespace-separated fields (min hour dom mon dow), got ${fields.length}`,
    );
  }
  const minutes = parseField(fields[0], "min", 0, 59);
  const hours = parseField(fields[1], "hour", 0, 23);
  requireStarOnly(fields[2], "dom");
  requireStarOnly(fields[3], "mon");
  requireStarOnly(fields[4], "dow");
  return { minutes, hours };
}

/** dom/mon/dow 范围 pin：仅 `*` */
function requireStarOnly(field: string, fieldName: string): void {
  if (field !== "*") {
    throw new RangeError(
      `schedule.cron.${fieldName}: only "*" is supported, got "${field}"`,
    );
  }
}

/**
 * 解析单个 min/hour 字段：逗号分段，每段支持 `*`、数字、区间、步进
 * （`*` 加 `/n` 与 `a-b/n`；单值加步进 `N/n` 不支持）。
 * 抛错表（均带字段名）：空段 / 倒序区间 / 非整数或 <1 的 step / 越界值 / 非法语法。
 */
function parseField(
  field: string,
  fieldName: string,
  lo: number,
  hi: number,
): Set<number> {
  const values = new Set<number>();
  for (const seg of field.split(",")) {
    if (seg === "") {
      throw new RangeError(
        `schedule.cron.${fieldName}: empty segment in "${field}"`,
      );
    }
    let base = seg;
    let step = 1;
    const slash = seg.indexOf("/");
    if (slash !== -1) {
      base = seg.slice(0, slash);
      step = parseStep(seg.slice(slash + 1), fieldName);
    }
    if (base === "*") {
      for (let v = lo; v <= hi; v += step) values.add(v);
      continue;
    }
    const dash = base.indexOf("-");
    if (dash !== -1) {
      const a = parseValue(base.slice(0, dash), fieldName, lo, hi);
      const b = parseValue(base.slice(dash + 1), fieldName, lo, hi);
      if (a > b) {
        throw new RangeError(
          `schedule.cron.${fieldName}: reversed range "${base}"`,
        );
      }
      for (let v = a; v <= b; v += step) values.add(v);
      continue;
    }
    if (slash !== -1) {
      throw new RangeError(
        `schedule.cron.${fieldName}: step on a single value ("N/n") is not supported: "${seg}"`,
      );
    }
    values.add(parseValue(base, fieldName, lo, hi));
  }
  return values;
}

function parseStep(raw: string, fieldName: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new RangeError(
      `schedule.cron.${fieldName}: step must be a positive integer, got "${raw}"`,
    );
  }
  return Number(raw);
}

function parseValue(raw: string, fieldName: string, lo: number, hi: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new RangeError(`schedule.cron.${fieldName}: invalid value "${raw}"`);
  }
  const v = Number(raw);
  if (v < lo || v > hi) {
    throw new RangeError(
      `schedule.cron.${fieldName}: value ${v} out of bounds (${lo}-${hi})`,
    );
  }
  return v;
}
