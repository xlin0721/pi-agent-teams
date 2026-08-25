// src/display/primitives.ts
// 文本/ANSI/合帧/环形缓冲纯原语（票 04 R#7 拆分自 render-core.ts）。零 node: 依赖。

import type { RenderLine } from "./types.ts";


/** 单行上限（UTF-16 码元近似 1MiB；超限截断 + 计数） */
export const MAX_LINE_CHARS = 1024 * 1024;
/** 环形缓冲逻辑行上限 */
export const RING_MAX_LINES = 500;
/** 环形缓冲总量预算（截断后行仍按 1MiB 计——单行 cost = min(len, 1MiB)） */
export const RING_BYTE_BUDGET = 8 * 1024 * 1024;

/** ANSI 状态机 pending 上限：未闭合序列暂存超过此值整段照发（防恶意无界内存） */
const STRIPPER_PENDING_MAX = 4096;

// ── 文本原语 ──────────────────────────────────────────────────────────────

/** 码点显示宽度：CJK/emoji=2、组合符/ZWJ/VS=0、其余 1。 */
export function charWidth(cp: string): number {
  if (cp.length === 0) return 0;
  const c = cp.codePointAt(0)!;
  if (c === 0x200d) return 0; // ZWJ
  if (c === 0xfe0e || c === 0xfe0f) return 0; // VS15/16
  if (
    (c >= 0x0300 && c <= 0x036f) ||
    (c >= 0x1ab0 && c <= 0x1aff) ||
    (c >= 0x1dc0 && c <= 0x1dff) ||
    (c >= 0x20d0 && c <= 0x20ff) ||
    (c >= 0xfe20 && c <= 0xfe2f)
  ) {
    return 0; // combining marks
  }
  if (
    (c >= 0x1100 && c <= 0x115f) || // Hangul Jamo
    (c >= 0x2329 && c <= 0x232a) ||
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || // CJK 部首..彝文
    (c >= 0xac00 && c <= 0xd7a3) || // Hangul 音节
    (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容表意
    (c >= 0xfe10 && c <= 0xfe19) || // 竖排标点
    (c >= 0xfe30 && c <= 0xfe6f) || // CJK 兼容形式
    (c >= 0xff00 && c <= 0xff60) || // 全角
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) || // emoji/杂项符号
    (c >= 0x20000 && c <= 0x3fffd) // CJK 扩展平面
  ) {
    return 2;
  }
  return 1;
}

/**
 * 按显示宽度折行（tab=8 列制表；宽字符/组合符/emoji 宽度感知）。
 * 入参为单条逻辑行（不含 \n；含 \n 时防御性切分）。
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  let cur = "";
  let col = 0;
  for (const cp of text) {
    if (cp === "\n") {
      out.push(cur);
      cur = "";
      col = 0;
      continue;
    }
    if (cp === "\t") {
      let adv = 8 - (col % 8);
      if (adv > width) adv = width;
      if (col + adv > width) {
        out.push(cur);
        cur = "";
        col = 0;
      }
      cur += " ".repeat(adv);
      col += adv;
      continue;
    }
    const w = charWidth(cp);
    if (col > 0 && col + w > width) {
      out.push(cur);
      cur = "";
      col = 0;
    }
    cur += cp;
    col += w;
  }
  if (cur !== "") out.push(cur);
  return out;
}

/** 截断到 max 码元，超限加 … 后缀。 */
export function truncateTo(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return text.slice(0, 1);
  return text.slice(0, max - 1) + "…";
}

/** 空白折叠为单空格 + 首尾去空白（工具摘要单行纪律）。 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** UTF-8 字节长度估算（环形缓冲预算用；零 import 自实现）。 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const cp of text) {
    const c = cp.codePointAt(0)!;
    if (c <= 0x7f) bytes += 1;
    else if (c <= 0x7ff) bytes += 2;
    else if (c <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

// ── ANSI 剥除状态机（跨 delta carry-over）─────────────────────────────────

/**
 * 五态状态机：ground / escape / csi / osc / st（DCS/SOS/PM/APC 统一 ST 终止）。
 * 未闭合序列暂存 pending，下一 feed 续拼（delta 边界劈开转义序列的场景）；
 * OSC/DCS 内容不入 pending（可能无界，只记状态）；pending 超 4096 整段照发。
 * ground 态剥除 C0 控制字符（\n \t 保留）。reset()=message 边界丢弃垃圾；
 * flush()=流结束照发暂存。
 */
export class AnsiStripper {
  private state: "ground" | "escape" | "csi" | "osc" | "st" = "ground";
  private pending = "";
  private stEsc = false; // st 态内见到 ESC，等 \ 收尾（ST）
  private oscEsc = false; // osc 态内见到 ESC，等 \ 收尾（ST）

  reset(): void {
    this.state = "ground";
    this.pending = "";
    this.stEsc = false;
    this.oscEsc = false;
  }

  flush(): string {
    const rest = this.pending;
    this.reset();
    return rest;
  }

  feed(text: string): string {
    let out = "";
    for (const cp of text) {
      const c = cp.codePointAt(0)!;
      switch (this.state) {
        case "ground": {
          if (c === 0x1b) {
            this.state = "escape";
            this.pending = "\x1b";
          } else if (cp === "\n" || cp === "\t") {
            out += cp;
          } else if (c < 0x20 || c === 0x7f) {
            // C0 控制字符（含 \r）与 DEL：剥除
          } else {
            out += cp;
          }
          break;
        }
        case "escape": {
          if (cp === "[") {
            this.state = "csi";
            this.pending += "[";
          } else if (cp === "]") {
            this.state = "osc";
            this.pending = "\x1b]";
            this.oscEsc = false;
          } else if (cp === "P" || cp === "X" || cp === "^" || cp === "_") {
            this.state = "st"; // DCS/SOS/PM/APC
            this.pending = "\x1b" + cp;
            this.stEsc = false;
          } else if ((c >= 0x40 && c <= 0x5f) || c === 0x63) {
            // C1 Fe 单字符序列（IND/NEL 等）+ RIS（ESC c）完整：剥除
            this.pending = "";
            this.state = "ground";
          } else {
            // 非法组合：ESC + 普通字符照发（忠实的保底）
            out += this.pending + cp;
            this.pending = "";
            this.state = "ground";
          }
          break;
        }
        case "csi": {
          if ((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f)) {
            this.pending += cp; // 参数/中间字节
            if (this.pending.length > STRIPPER_PENDING_MAX) {
              out += this.pending;
              this.pending = "";
              this.state = "ground";
            }
          } else if (c >= 0x40 && c <= 0x7e) {
            this.pending = ""; // final 字节：序列完整剥除
            this.state = "ground";
          } else {
            out += this.pending + cp; // 非法：照发保底
            this.pending = "";
            this.state = "ground";
          }
          break;
        }
        case "osc": {
          if (this.oscEsc) {
            this.oscEsc = false;
            if (cp === "\\") {
              // ST 收尾：完整剥除
              this.pending = "";
              this.state = "ground";
            } else if (c === 0x1b) {
              this.oscEsc = true; // 连续 ESC 再等
            } else {
              out += this.pending + "\x1b" + cp; // 非法组合照发
              this.pending = "";
              this.state = "ground";
            }
          } else if (c === 0x07) {
            // BEL 收尾
            this.pending = "";
            this.state = "ground";
          } else if (c === 0x1b) {
            this.oscEsc = true;
          }
          // 其余 = OSC 内容：不入 pending（无界输出防内存），持续到收尾
          break;
        }
        case "st": {
          if (this.stEsc) {
            this.stEsc = false;
            if (cp === "\\") {
              this.pending = "";
              this.state = "ground";
            } else if (c === 0x1b) {
              this.stEsc = true;
            }
            // 其余：回到 st 内容继续忽略
          } else if (c === 0x1b) {
            this.stEsc = true;
          }
          break;
        }
      }
    }
    return out;
  }
}

/** 一次性剥除（工具摘要等短文本用）。 */
export function stripAnsiText(text: string): string {
  const s = new AnsiStripper();
  return s.feed(text) + s.flush();
}

// ── NDJSON 合帧 ───────────────────────────────────────────────────────────

/**
 * \n 分割 + strip 尾部 \r（spike §K1：rpc stdout LF 合帧，实测 0 条 \r——防御性
 * 剥离）；单行 >1MiB：截断到 1MiB 后不再缓冲（防无界内存），完成时计数。
 * 坏行计数归 RenderSession（JSON.parse 失败）；oversize 计数在本类。
 */
export class LineFramer {
  oversizeLines = 0;
  private pending = "";
  private pendingOversize = false;

  feed(chunk: string): string[] {
    const lines: string[] = [];
    let pos = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", pos);
      if (nl === -1) break;
      let line = this.pending + chunk.slice(pos, nl);
      const wasOversize = this.pendingOversize;
      this.pending = "";
      this.pendingOversize = false;
      if (wasOversize || line.length > MAX_LINE_CHARS) {
        line = line.slice(0, MAX_LINE_CHARS);
        this.oversizeLines++;
      }
      lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
      pos = nl + 1;
    }
    const rest = chunk.slice(pos);
    if (!this.pendingOversize) {
      this.pending += rest;
      if (this.pending.length > MAX_LINE_CHARS) {
        this.pendingOversize = true;
        this.pending = this.pending.slice(0, MAX_LINE_CHARS);
      }
    }
    return lines;
  }
}

// ── 环形缓冲（500 逻辑行 + 8MiB 预算 + 省略计数）────────────────────────────

/** 环形缓冲：逻辑行 + 字节预算（单行 cost = min(utf8 长度, 1MiB)）逐行驱逐。 */
export class RingBuffer {
  private lines: RenderLine[] = [];
  private bytes = 0;
  private omitted = 0;

  push(line: RenderLine): void {
    const cost = Math.min(utf8ByteLength(line.text), MAX_LINE_CHARS);
    this.lines.push(line);
    this.bytes += cost;
    while (this.lines.length > RING_MAX_LINES || this.bytes > RING_BYTE_BUDGET) {
      const evicted = this.lines.shift()!;
      this.bytes -= Math.min(utf8ByteLength(evicted.text), MAX_LINE_CHARS);
      this.omitted++;
    }
  }

  snapshot(): RenderLine[] {
    return [...this.lines];
  }

  getOmitted(): number {
    return this.omitted;
  }
}

