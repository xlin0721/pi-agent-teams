// src/display/layout.ts
// 状态条 + 终端布局输出（票 04 R#7 拆分自 render-core.ts）。零 node: 依赖。

import type { LineKind, RenderLine, StatusModel, TermSize } from "./types.ts";
import { truncateTo } from "./primitives.ts";

/** 窄 pane 阈值（<40 列只留 taskId8+阶段，评审整改 frontend#6） */
export const NARROW_COLS = 40;

// ── 状态条 ────────────────────────────────────────────────────────────────

/** 耗时格式化：⏱ 1h23m / ⏱ 5m07s / ⏱ 42s。 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `⏱ ${h}h${m}m`;
  if (m > 0) return `⏱ ${m}m${s}s`;
  return `⏱ ${s}s`;
}

/**
 * 状态条纯文本（宽度外颜色无涉）：<40 列只留 taskId8+阶段（frontend#6）；
 * 宽态按优先级 taskId8 > 角色 > 标签 > 阶段 > steer 排队徽标 > steer 通道关闭 >
 * 回合 > tok > 耗时 > ⚠坏行 > ⚠巨行 > cwd，超宽从右向左裁剪，最后截断加 …。
 */
export function renderStatusText(model: StatusModel, width: number): string {
  if (width < NARROW_COLS) {
    return truncateTo(`${model.taskId8} ${model.phase}`, width);
  }
  const parts: string[] = [model.taskId8];
  if (model.role !== "") parts.push(model.role);
  parts.push(model.label);
  parts.push(model.phase);
  if (model.steerQueued > 0) {
    parts.push(`⏳ steer 排队 ${model.steerQueued}`);
  } else if (model.steerSent) {
    parts.push("⏳ 已发送"); // 乐观瞬态（提交后、queue_update 回来前）
  }
  if (model.steerClosed) parts.push("⚠ steer 通道关闭");
  if (model.steerRejected !== null) {
    parts.push(
      model.steerRejected === "（未给原因）" ? "⚠ steer 被拒" : `⚠ steer 被拒: ${model.steerRejected}`,
    );
  }
  if (model.turn > 0) parts.push(`回合 ${model.turn}`);
  if (model.totalTokens !== null) parts.push(`tok ${model.totalTokens}`);
  parts.push(formatElapsed(model.elapsedMs));
  if (model.badLines > 0) parts.push(`⚠坏行 ${model.badLines}`);
  if (model.oversizeLines > 0) parts.push(`⚠巨行 ${model.oversizeLines}`);
  if (model.cwd !== "") parts.push(model.cwd);
  let text = parts.join(" │ ");
  while (text.length > width && parts.length > 1) {
    parts.pop();
    text = parts.join(" │ ");
  }
  return truncateTo(text, width);
}

/** 状态条着色（整条 bold；徽标自带 emoji）。 */
export function colorizeStatus(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

// ── 布局输出（DECSTBM + 光标出入区纪律）─────────────────────────────────────

/** 输出行着色（kind → SGR；tool-error 红色 + ✗ 失败文字标记并列，a11y frontend#7）。 */
export function colorizeLine(kind: LineKind, text: string): string {
  switch (kind) {
    case "system":
    case "thinking":
      return `\x1b[2m${text}\x1b[0m`;
    case "phase":
      return `\x1b[1;33m${text}\x1b[0m`;
    case "user":
    case "tool":
      return `\x1b[36m${text}\x1b[0m`;
    case "tool-error":
      return `\x1b[31m${text}\x1b[0m`;
    default:
      return text;
  }
}

/**
 * 终端布局状态机：DECSTBM 滚动区 2..rows-1（状态条 row1 常驻、输入行所在最底行
 * 在区域外）+ printLine 光标出入区纪律（写输出前入区、写完出区回输入行——
 * 05 在出区后 rl.prompt(true) 重绘输入行）。rows<3 退化：无状态条、全屏区域。
 * 全部方法返回纯转义序列（零 I/O）；行已按宽度折好（≤cols，防终端自折破坏记账）。
 */
export class TerminalLayout {
  private rows: number;
  private cols: number;
  private linesEmitted = 0;

  constructor(size: TermSize) {
    this.rows = clampSize(size.rows, 24);
    this.cols = clampSize(size.cols, 80);
  }

  get width(): number {
    return this.cols;
  }

  get regionTop(): number {
    return this.rows >= 3 ? 2 : 1;
  }

  get regionBottom(): number {
    return this.rows >= 3 ? this.rows - 1 : this.rows;
  }

  get regionHeight(): number {
    return this.regionBottom - this.regionTop + 1;
  }

  /** 输入行 = 最底行（滚动区外） */
  get inputRow(): number {
    return this.rows;
  }

  setSize(size: TermSize): void {
    this.rows = clampSize(size.rows, 24);
    this.cols = clampSize(size.cols, 80);
    this.linesEmitted = Math.min(this.linesEmitted, this.regionHeight);
  }

  /** 初始：清屏 + 设滚动区。 */
  setup(): string {
    return "\x1b[2J\x1b[H" + this.setRegionSeq();
  }

  /** 写状态条（row1）后出区（光标回输入行）。rows<3 无状态条 → 空串。 */
  paintStatus(text: string): string {
    if (this.rows < 3) return "";
    return this.goTo(1) + "\x1b[2K" + text + this.exitRegion();
  }

  /**
   * 入区写输出（append-only）：未满区写下一空行；满区写区底 + \r\n 触发区滚动。
   * 写完出区（光标回输入行）。行已折至 ≤cols。
   */
  paintLines(entries: readonly RenderLine[]): string {
    if (entries.length === 0) return "";
    let out = "";
    for (const e of entries) {
      const text = colorizeLine(e.kind, e.text);
      if (this.linesEmitted < this.regionHeight - 1) {
        // 非底行：写 + \r\n 移到下一行（未到滚动区底部，不触发滚动）
        out += this.goTo(this.regionTop + this.linesEmitted) + "\x1b[2K" + text + "\r\n";
        this.linesEmitted++;
      } else {
        // 底行（regionBottom）：写文本不带尾 \n（评审 R#1：regionBottom 的 \n 会触发
        // DECSTBM 区滚动，把刚写的新行卷到 regionBottom-1、底行恒空、每次 append 丢一行）。
        // 已满时先 \n 滚动清出底行，再写文本。
        if (this.linesEmitted >= this.regionHeight) {
          out += this.goTo(this.regionBottom) + "\n";
        }
        out += this.goTo(this.regionBottom) + "\x1b[2K" + text;
        this.linesEmitted = this.regionHeight;
      }
    }
    return out + this.exitRegion();
  }

  /**
   * 全量重绘（SIGWINCH 四件套的 1-3 步 / 首屏）：重设滚动区 + 状态条 + 区域清空
   * 后写可见行（尾部 regionHeight 条）→ 出区。第 4 步（rl.prompt 重绘输入行）
   * 归装配层 onBottomRow 钩子。
   */
  repaint(statusText: string, entries: readonly RenderLine[]): string {
    let out = this.setRegionSeq();
    if (this.rows >= 3) out += this.goTo(1) + "\x1b[2K" + statusText;
    for (let r = this.regionTop; r <= this.regionBottom; r++) {
      out += this.goTo(r) + "\x1b[2K";
    }
    this.linesEmitted = 0;
    out += this.paintLines(entries.slice(-this.regionHeight));
    return out;
  }

  private setRegionSeq(): string {
    return this.rows >= 3 ? `\x1b[2;${this.rows - 1}r` : "\x1b[r";
  }

  private exitRegion(): string {
    return this.goTo(this.inputRow);
  }

  private goTo(row: number): string {
    return `\x1b[${row};1H`;
  }
}

function clampSize(v: number, fallback: number): number {
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

