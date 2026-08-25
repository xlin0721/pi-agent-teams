// src/display/session.ts
// RenderSession 事件组装 + 渲染模型（票 04 R#7 拆分自 render-core.ts）。零 node: 依赖。

import type { RenderLine, StatusModel } from "./types.ts";
import { AnsiStripper, LineFramer, RingBuffer, collapseWhitespace, stripAnsiText, truncateTo, wrapText } from "./primitives.ts";
import { TOOL_SUMMARY_MAX, countStringArray, extractTextBlocks, extractThinkingBlocks, extractUsage, formatToolArgs, formatToolResult } from "./tools.ts";

// ── 事件组装 + 渲染模型 ───────────────────────────────────────────────────

export interface RenderSessionOpts {
  taskId: string;
  role: string;
  /** 注入的初始 prompt（首条 user message 同文回显时跳过——首屏已显示预览） */
  prompt: string;
  /** 耗时锚：task record startedAt；0 → 构造时刻 */
  startedAt: number;
  now?: () => number;
}

/**
 * 事件组装 + 渲染模型核心：consume(chunk) 合帧 + consumeLine(line) 单事件。
 * 纯状态机（零 I/O）：环形缓冲 500 逻辑行 + 8MiB 预算、ANSI carry-over 组装、
 * 阶段机、steer 排队态、usage、状态条数据模型。
 */
export class RenderSession {
  /** agent_settled 之后为 true（§Q4：输入行边缘策略改用 prompt 注入） */
  settled = false;

  private readonly ring = new RingBuffer();
  private readonly framer = new LineFramer();
  private readonly stripper = new AnsiStripper();
  private readonly taskId: string;
  private readonly role: string;
  private readonly prompt: string;
  private readonly startedAt: number;
  private readonly nowFn: () => number;
  private readonly bootAt: number;

  private pendingText = "";
  private pendingThinking = "";
  /** 已入 pending 的原始（含转义）delta 字符数——message_end 权威校正差分基准 */
  private displayedTextChars = 0;
  private displayedThinkingChars = 0;
  private turn = 0;
  private phase = "等待首个事件";
  private totalTokens: number | null = null;
  private steerQueued = 0;
  private steerClosed = false;
  private steerRejected: string | null = null;
  private steerSent = false;
  private badLines = 0;
  private cwd = "";
  private firstUserHandled = false;

  constructor(opts: RenderSessionOpts) {
    this.taskId = opts.taskId;
    this.role = opts.role;
    this.prompt = opts.prompt;
    this.startedAt = opts.startedAt;
    this.nowFn = opts.now ?? Date.now;
    this.bootAt = this.nowFn();
    // 首屏（taskId/角色/prompt 前 60 字 + 等待首个事件）
    this.pushLine({
      text: `任务 ${this.taskId} │ 角色: ${this.role === "" ? "（未指定）" : this.role}`,
      kind: "system",
    });
    const preview = truncateTo(collapseWhitespace(this.prompt), 60);
    if (preview !== "") this.pushLine({ text: `📋 ${preview}`, kind: "system" });
    this.pushLine({ text: "等待首个事件…", kind: "system" });
  }

  /** 合帧 + 逐事件消费（pi stdout 数据块）。 */
  consume(chunk: string): void {
    for (const line of this.framer.feed(chunk)) this.consumeLine(line);
  }

  /** 单事件行（fixture 逐条断言用）：坏行计数跳过不崩。 */
  consumeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.badLines++;
      return;
    }
    this.handleEvent(parsed);
  }

  /** 系统诊断行（spawn 失败等，装配层注入）。 */
  addSystemLine(text: string): void {
    this.pushLine({ text, kind: "system" });
  }

  setSteerClosed(closed: boolean): void {
    this.steerClosed = closed;
  }

  /** 提交前清 stale 拒态（新一轮 steer 重置上一条 success:false 的「被拒」提示）。 */
  clearSteerFeedback(): void {
    this.steerRejected = null;
  }

  /** 乐观瞬态（票 06 追加）：提交 steer 时置位，queue_update 回来时清除。 */
  setSteerSent(): void {
    this.steerSent = true;
  }

  /** pi 退出终态：settled 且码 0 保持「已结束」，否则标退出码。 */
  markExit(code: number): void {
    if (this.settled && code === 0) return;
    this.phase = code === 0 ? "已退出" : `已退出（码 ${code}）`;
  }

  getLines(): RenderLine[] {
    return this.ring.snapshot();
  }

  getOmitted(): number {
    return this.ring.getOmitted();
  }

  getStatus(): StatusModel {
    const anchor = this.startedAt > 0 ? this.startedAt : this.bootAt;
    return {
      taskId: this.taskId,
      taskId8: this.taskId.slice(0, 8),
      role: this.role,
      phase: this.phase,
      turn: this.turn,
      totalTokens: this.totalTokens,
      startedAt: this.startedAt,
      label: "运行中",
      steerQueued: this.steerQueued,
      steerSent: this.steerSent,
      steerClosed: this.steerClosed,
      steerRejected: this.steerRejected,
      badLines: this.badLines,
      oversizeLines: this.framer.oversizeLines,
      cwd: this.cwd,
      elapsedMs: Math.max(0, this.nowFn() - anchor),
    };
  }

  /**
   * 可见区渲染：省略标记（若有）+ 逻辑行按宽折行 → 取尾部 maxLines 条。
   * SIGWINCH 按新宽重折行即调用本方法（逻辑行存储 + 渲染时折行，无 reflow 标记）。
   */
  renderVisible(cols: number, maxLines: number): RenderLine[] {
    const all: RenderLine[] = [];
    for (const l of this.ring.snapshot()) {
      for (const piece of wrapText(l.text, cols)) {
        all.push({ text: piece, kind: l.kind });
      }
    }
    const omitted = this.ring.getOmitted();
    if (maxLines <= 0) {
      return omitted > 0 ? [{ text: `…(省略 ${omitted} 行)`, kind: "system" }, ...all] : all;
    }
    const markerLines = omitted > 0 ? 1 : 0;
    const body = all.slice(-Math.max(0, maxLines - markerLines));
    return omitted > 0 ? [{ text: `…(省略 ${omitted} 行)`, kind: "system" }, ...body] : body;
  }

  // ── 内部：事件分发 ──

  private handleEvent(raw: unknown): void {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      this.badLines++;
      return;
    }
    const ev = raw as Record<string, unknown>;
    const type = ev["type"];
    if (typeof type !== "string") return; // 合法 JSON 非事件对象 → 忽略
    switch (type) {
      case "session": {
        const c = ev["cwd"];
        if (typeof c === "string") this.cwd = c;
        break; // version 字段忽略（≠3 容忍）
      }
      case "agent_start":
        this.phase = "agent 启动";
        this.pushLine({ text: "▶ agent 启动", kind: "phase" });
        break;
      case "agent_end": {
        const willRetry = ev["willRetry"] === true;
        this.flushPending();
        this.phase = willRetry ? "等待自动重试" : "回合收尾";
        this.pushLine({
          text: willRetry ? "▶ agent 回合结束（将自动重试）" : "▶ agent 回合结束",
          kind: "phase",
        });
        break;
      }
      case "agent_settled":
        this.settled = true;
        this.phase = "已结束";
        this.pushLine({ text: "▶ 已结束（agent_settled）", kind: "phase" });
        break;
      case "turn_start":
        this.turn++;
        this.phase = `回合 ${this.turn}`;
        this.pushLine({ text: `── 回合 ${this.turn} ──`, kind: "phase" });
        break;
      case "turn_end":
        this.flushPending();
        this.ingestUsage(ev["message"]);
        this.phase = "回合结束";
        break;
      case "message_start":
        this.onMessageStart(ev["message"]);
        break;
      case "message_update":
        this.onMessageUpdate(ev["assistantMessageEvent"]);
        break;
      case "message_end":
        this.onMessageEnd(ev["message"]);
        break;
      case "tool_execution_start":
        this.onToolStart(ev);
        break;
      case "tool_execution_update":
        this.onToolUpdate(ev);
        break;
      case "tool_execution_end":
        this.onToolEnd(ev);
        break;
      case "queue_update":
        // spike §Q：排队态显示数据源 = steering.length；容错计数；清空 = 徽标熄灭。
        // 不覆盖 phase（排队态只进状态条，不冒充当前活动阶段）。
        // 收到权威队列状态 → 清乐观「已发送」瞬态。
        this.steerQueued = countStringArray(ev["steering"]);
        this.steerSent = false;
        break;
      case "response": {
        // 票 05：stdin 行协议命令的成败态。spike §S2 形状 {"type":"response",
        // "command":"steer","success":true}。success:false 形状未实测 → 容错假设：
        // success 非 boolean 忽略；error 缺字段/非 string → 通用「被拒」不带原因。
        if (ev["command"] !== "steer") break; // get_state 等其它命令的 response 忽略
        if (ev["success"] === true) {
          this.steerRejected = null;
        } else if (ev["success"] === false) {
          const err = ev["error"];
          const reason = typeof err === "string" && err !== "" ? err : null;
          this.steerRejected = reason !== null ? truncateTo(reason, 200) : "（未给原因）";
        }
        break;
      }
      case "compaction_start":
        this.flushPending();
        this.phase = "压缩中";
        this.pushLine({ text: "▶ 上下文压缩中", kind: "phase" });
        break;
      case "compaction_end":
        this.phase = "压缩完成";
        this.pushLine({ text: "▶ 压缩完成", kind: "phase" });
        break;
      default:
        break; // 未知事件一律忽略（forward-compat）
    }
  }

  private onMessageStart(rawMsg: unknown): void {
    if (rawMsg === null || typeof rawMsg !== "object") return;
    const msg = rawMsg as Record<string, unknown>;
    const role = msg["role"];
    if (role === "user") {
      this.flushPending();
      const text = extractTextBlocks(msg["content"]);
      const isPromptEcho = !this.firstUserHandled && this.prompt !== "" && text === this.prompt;
      this.firstUserHandled = true;
      if (!isPromptEcho && text !== "") {
        // spike §S4：steer 以 user 消息入流可回显
        this.phase = "steer 送达";
        const lines = text.split("\n");
        if (lines[lines.length - 1] === "" && lines.length > 1) lines.pop(); // 尾随空行丢弃
        for (let i = 0; i < lines.length; i++) {
          const clean = stripAnsiText(lines[i]!);
          this.pushLine({ text: i === 0 ? `👤 ${clean}` : clean, kind: "user" });
        }
      }
    } else if (role === "assistant") {
      this.phase = "生成中…";
      // 新消息边界：重置 delta 权威校正差分基准（跨消息累计会误判超发/缺失）
      this.displayedTextChars = 0;
      this.displayedThinkingChars = 0;
    }
  }

  private onMessageUpdate(rawEv: unknown): void {
    if (rawEv === null || typeof rawEv !== "object") return;
    const ev = rawEv as Record<string, unknown>;
    const etype = ev["type"];
    if (typeof etype !== "string") return;
    switch (etype) {
      case "text_start":
        this.flushPending(); // thinking 块边界
        this.phase = "写回";
        break;
      case "text_delta": {
        const d = ev["delta"];
        if (typeof d === "string") this.ingest("text", d);
        this.phase = "写回";
        break;
      }
      case "text_end": {
        this.stripper.reset(); // 块边界：未闭合序列=垃圾
        // 块级权威校正已移除（评审 R#2）：多文本块消息下，块级 content 对消息级
        // 累计差分基准 applyAuthoritative 会误清非首块文本（可致永久丢字）；权威
        // 校正只留 message_end（render 协议约定「Treat message_end.message as authoritative」）。
        this.flushPending();
        break;
      }
      case "thinking_start":
        this.flushPending();
        this.phase = "思考中";
        break;
      case "thinking_delta": {
        const d = ev["delta"];
        if (typeof d === "string") this.ingest("thinking", d);
        this.phase = "思考中";
        break;
      }
      case "thinking_end": {
        this.stripper.reset();
        // 同 text_end：块级权威校正移除，只留 message_end（评审 R#2）。
        this.flushPending();
        break;
      }
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        this.phase = "构造工具调用";
        break; // 工具调用内容不显示（tool_execution_start 摘要覆盖）
      default:
        break;
    }
  }

  private onMessageEnd(rawMsg: unknown): void {
    if (rawMsg === null || typeof rawMsg !== "object") return;
    const msg = rawMsg as Record<string, unknown>;
    if (msg["role"] === "assistant") {
      this.stripper.reset(); // 权威校正前丢弃未闭合垃圾
      this.applyAuthoritative(
        extractTextBlocks(msg["content"]),
        extractThinkingBlocks(msg["content"]),
      );
      this.flushPending();
    }
    this.ingestUsage(msg); // usage 无独立事件（assistant 消息携带）
  }

  private onToolStart(ev: Record<string, unknown>): void {
    this.flushPending();
    const name = this.toolName(ev);
    this.phase = `工具: ${name}`;
    const argsText = formatToolArgs(ev["args"]);
    this.pushLine({
      text: argsText === "" ? `🔧 ${name}` : `🔧 ${name}: ${argsText}`,
      kind: "tool",
    });
  }

  private onToolUpdate(ev: Record<string, unknown>): void {
    // 仅错误显示（rpc.md 该事件无 isError 字段——容错假设 partialResult.isError
    // === true 或 partialResult.error 非空字符串；权威错误显示归 tool_execution_end）
    const pr = ev["partialResult"];
    if (pr === null || typeof pr !== "object") return;
    const p = pr as Record<string, unknown>;
    const errorField = p["error"];
    const isError = p["isError"] === true || (typeof errorField === "string" && errorField !== "");
    if (!isError) return;
    this.flushPending();
    const name = this.toolName(ev);
    const text = extractTextBlocks(p["content"]);
    const detail = text !== "" ? text : typeof errorField === "string" ? errorField : "";
    this.phase = `工具输出错误: ${name}`;
    this.pushLine({
      text: `⚠ ${name} 输出: ${truncateTo(collapseWhitespace(stripAnsiText(detail)), TOOL_SUMMARY_MAX)}`,
      kind: "tool-error",
    });
  }

  private onToolEnd(ev: Record<string, unknown>): void {
    this.flushPending();
    const name = this.toolName(ev);
    const isError = ev["isError"] === true;
    const resultText = formatToolResult(ev["result"]);
    if (isError) {
      this.phase = `工具失败: ${name}`;
      this.pushLine({
        text: resultText === "" ? `✗ 失败 ${name}` : `✗ 失败 ${name}: ${resultText}`,
        kind: "tool-error",
      });
    } else {
      this.phase = `工具完成: ${name}`;
      this.pushLine({
        text: resultText === "" ? `✓ ${name} 完成` : `✓ ${name} 完成: ${resultText}`,
        kind: "tool",
      });
    }
  }

  private toolName(ev: Record<string, unknown>): string {
    const n = ev["toolName"];
    return typeof n === "string" && n !== "" ? n : "tool";
  }

  private ingestUsage(msg: unknown): void {
    const usage = extractUsage(msg);
    if (usage !== null && usage.totalTokens !== null) this.totalTokens = usage.totalTokens;
  }

  // ── 内部：delta 组装 + 权威校正 ──

  /** delta 追加（ANSI 剥除在组装后文本层做；跨 delta carry-over 由 stripper 承载）。 */
  private ingest(kind: "text" | "thinking", raw: string): void {
    const clean = this.stripper.feed(raw);
    if (kind === "text") {
      this.pendingText += clean;
      this.displayedTextChars += raw.length;
    } else {
      this.pendingThinking += clean;
      this.displayedThinkingChars += raw.length;
    }
    this.splitPending(kind);
  }

  /** pending 中完整行推入环形缓冲，保留尾行。 */
  private splitPending(kind: "text" | "thinking"): void {
    const buf = kind === "text" ? this.pendingText : this.pendingThinking;
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const pieces = buf.split("\n");
    const last = pieces.length - 1;
    for (let i = 0; i < last; i++) {
      this.pushLine({
        text: pieces[i]!,
        kind: kind === "text" ? "assistant" : "thinking",
      });
    }
    if (kind === "text") this.pendingText = pieces[last]!;
    else this.pendingThinking = pieces[last]!;
  }

  /** 边界 flush：thinking 先于 text（到达序）。 */
  private flushPending(): void {
    if (this.pendingThinking !== "") {
      this.pushLine({ text: this.pendingThinking, kind: "thinking" });
      this.pendingThinking = "";
    }
    if (this.pendingText !== "") {
      this.pushLine({ text: this.pendingText, kind: "assistant" });
      this.pendingText = "";
    }
  }

  /**
   * message_end/text_end 权威校正（后缀差分模型，原始字符空间——deltas 与权威
   * 内容同含转义序列，长度可比）：权威长度 ≥ 已入 pending 原始字符数 → 续拼剩余
   * （相等=内容已齐，保持 pending）；权威更短（deltas 超发）→ 丢弃未 flush 尾部
   * （append-only 显示不可回退已上屏行）。
   */
  private applyAuthoritative(authText: string | null, authThinking: string | null): void {
    if (authText !== null) {
      if (authText.length >= this.displayedTextChars) {
        const remainder = authText.slice(this.displayedTextChars);
        this.displayedTextChars = authText.length;
        if (remainder !== "") {
          this.pendingText += this.stripper.feed(remainder);
          this.splitPending("text");
        }
      } else {
        this.pendingText = "";
        this.displayedTextChars = authText.length;
      }
    }
    if (authThinking !== null) {
      if (authThinking.length >= this.displayedThinkingChars) {
        const remainder = authThinking.slice(this.displayedThinkingChars);
        this.displayedThinkingChars = authThinking.length;
        if (remainder !== "") {
          this.pendingThinking += this.stripper.feed(remainder);
          this.splitPending("thinking");
        }
      } else {
        this.pendingThinking = "";
        this.displayedThinkingChars = authThinking.length;
      }
    }
  }

  private pushLine(line: RenderLine): void {
    this.ring.push(line);
  }
}

