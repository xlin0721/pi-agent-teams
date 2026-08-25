// src/display/render-core.ts
// B 形态渲染器（票 04）：装配层 + barrel re-export。
// R#7 拆分：纯逻辑/类型已拆到 types/primitives/tools/session/layout 子模块，本文件
// 保留 runRenderer 装配 + computeExitCode + DEFAULT_* 常量，并 re-export 全部导出
// （04 测试与 05 计划 import 面零变化）。
//
// 权威事实来源：.scratch/m2.5-b-form/spike-facts-m25.md（T0 定案 A2）+ spec.md + 票 04。
// 零副作用纪律：输出只走注入的 output，进程级信号/exit 归 render-mini。

export * from "./types.ts";
export * from "./primitives.ts";
export * from "./tools.ts";
export * from "./session.ts";
export * from "./layout.ts";

import { StringDecoder } from "node:string_decoder";
import { RenderSession } from "./session.ts";
import { TerminalLayout, colorizeStatus, renderStatusText } from "./layout.ts";
import { stripAnsiText, utf8ByteLength, wrapText } from "./primitives.ts";
import type { ChunkLike, PiChild, ReadableLike, RenderLine, SpawnPi, StatusModel, TermSize, WritableLike } from "./types.ts";

// ── 常量 ────────────────────────────────────────────────────────────
export const DEFAULT_FLUSH_MS = 33;
export const DEFAULT_STATUS_THROTTLE_MS = 500;
export const DEFAULT_ELAPSED_TICK_MS = 1000;
/** 单条 steer 上限（spike §E 定值 64K 满阻塞警戒；超限拒发，防呆而非背压机制） */
export const MAX_STEER_BYTES = 64 * 1024;

// ── 退出码 ────────────────────────────────────────────────────────────────

const SIGNAL_CODES: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGTERM: 15,
};

/** pi 退出码：有码取码；信号死 128+n；无码无信号 0；未知信号保守 128。 */
export function computeExitCode(code: number | null, signal: string | null): number {
  if (typeof code === "number") return code;
  if (signal === null || signal === "") return 0;
  const m = /^SIG(\d+)$/.exec(signal);
  if (m !== null) return 128 + Number(m[1]);
  const mapped = SIGNAL_CODES[signal];
  return mapped !== undefined ? 128 + mapped : 128;
}

// ── runRenderer 装配 ──────────────────────────────────────────────────────

export interface RendererDeps {
  /** 事件流源；null/缺省 → spawnPi().stdout（fixture 注入用） */
  input?: ReadableLike | null;
  output: WritableLike;
  spawnPi: SpawnPi;
  /** resize 订阅注入；缺省 process.stdout.on("resize") */
  onResize?: (cb: () => void) => void;
}

export interface RendererOpts {
  taskId: string;
  role: string;
  prompt: string;
  /** 耗时锚：task record startedAt（启动时读一次，零写入） */
  startedAt: number;
  /** 缺省 stdout columns/rows，退化 {rows:24, cols:80} */
  getSize?: () => TermSize;
  now?: () => number;
  flushMs?: number;
  statusThrottleMs?: number;
  elapsedTickMs?: number;
  /** 降级开关（backend#15 预案）：false → flush 改走全量 repaint（绝对定位重写，不靠 \r\n 滚动）；缺省 true（DECSTBM 增量 append） */
  appendScroll?: boolean;
  /** 每次 paint 后钩子（05：rl.prompt(true) 重绘输入行；本票预留） */
  onBottomRow?: () => void;
}

export interface RendererHandle {
  /** spawnPi 产物（stdin 引用暴露给装配层——05 steer 接线用）；spawn 抛错为 null */
  child: PiChild | null;
  session: RenderSession;
  layout: TerminalLayout;
  /** pi 退出码（spawn error → 127；信号死 128+n） */
  done: Promise<number>;
  /** 清定时器（测试收尾；done 决议时自动清） */
  close(): void;
  /**
   * stdin 行协议写（spike §E 写纪律）：写挂 error 回调 + EPIPE/ERR_STREAM_DESTROYED/
   * ERR_STREAM_WRITE_AFTER_END 三码收敛为状态条「steer 通道关闭」，绝不抛未捕获异常。
   */
  sendCommand(obj: unknown): void;
  /**
   * 输入行边缘策略（spike §Q4 定值，本票落码）：agent_settled 之后 → prompt 注入
   * （prompt 在非流式态立即触发新回合；steer 只入队不触发）；否则 steer。
   */
  injectUserMessage(message: string): void;
  /** 系统行注入 + 立即调度 flush（FE#2：无数据事件时 notice 仍上屏） */
  injectSystemLine(text: string): void;
}

/** 默认 resize 订阅（process.stdout.on("resize")；非 TTY 环境静默）。 */
function defaultOnResize(cb: () => void): void {
  const out = process.stdout as unknown as { on?: (event: string, listener: () => void) => unknown };
  try {
    out.on?.("resize", cb);
  } catch {
    // 无 resize 面：忽略
  }
}

/** 默认尺寸（stdout columns/rows；退化 {24,80}）。 */
function defaultGetSize(): TermSize {
  const out = process.stdout as unknown as { columns?: unknown; rows?: unknown };
  const cols = typeof out.columns === "number" && out.columns > 0 ? out.columns : 80;
  const rows = typeof out.rows === "number" && out.rows > 0 ? out.rows : 24;
  return { rows, cols };
}

/**
 * 装配：spawn pi → 首屏重绘 → stdin 注入初始 prompt（rpc 行协议）→ 事件流驱动
 * 33ms flush 合帧 / 500ms 状态节流 / 1s 耗时 tick（静默态=耗时继续走）→ SIGWINCH
 * 四件套 → pi exit/error 终态 paint → done 码。零进程级副作用（exit 归 render-mini）。
 */
export function runRenderer(deps: RendererDeps, opts: RendererOpts): RendererHandle {
  const nowFn = opts.now ?? Date.now;
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  const throttleMs = opts.statusThrottleMs ?? DEFAULT_STATUS_THROTTLE_MS;
  const tickMs = opts.elapsedTickMs ?? DEFAULT_ELAPSED_TICK_MS;
  const getSize = opts.getSize ?? defaultGetSize;
  const appendScroll = opts.appendScroll ?? true;

  // 首屏输入边界 sanitize（票 09 #5）：taskId/role/prompt 三值在装配边界剥 ANSI/控制符，
  // 既喂首屏/状态条也喂 prompt 注入——session.ts 零改动。
  const safeTaskId = stripAnsiText(opts.taskId).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const safeRole = stripAnsiText(opts.role).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const safePrompt = stripAnsiText(opts.prompt).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const session = new RenderSession({
    taskId: safeTaskId,
    role: safeRole,
    prompt: safePrompt,
    startedAt: opts.startedAt,
    now: nowFn,
  });
  const layout = new TerminalLayout(getSize());

  let child: PiChild | null = null;
  let finalized = false;
  let resolveDone: ((code: number) => void) | null = null;
  const done = new Promise<number>((res) => {
    resolveDone = res;
  });

  let flushTimer: number | null = null;
  let statusTimer: number | null = null;
  let tickTimer: number | null = null;
  let lastStatusPaint = -Infinity;
  // 已 flush 的全局逻辑行数（单调递增：环形驱逐使 snapshot 左移，绝对索引会失效，
  // 故用「已驱逐数 omitted + 当前行长」作单调水位，驱逐不回退——评审 R#1）
  let flushedTotal = 0;

  const writeOut = (s: string): void => {
    if (s === "") return;
    try {
      deps.output.write(s);
    } catch {
      // 输出面关闭：静默（终态诊断已不可达，不放大故障）
    }
  };

  const statusString = (): string =>
    colorizeStatus(renderStatusText(session.getStatus(), layout.width));

  const paintStatus = (): void => {
    lastStatusPaint = nowFn();
    writeOut(layout.paintStatus(statusString()));
    // ⚠️②（票 05 answerer 修正）：paintStatus 后光标已回输入行 col1，但不重绘输入行
    // 会让 readline 内部 cursor 账本与实际位置漂移 → 下次按键写错列（撕裂）。统一收尾。
    opts.onBottomRow?.();
  };

  const requestStatus = (): void => {
    const wait = throttleMs - (nowFn() - lastStatusPaint);
    if (wait <= 0) {
      paintStatus();
      return;
    }
    if (statusTimer === null) {
      statusTimer = setTimeout(() => {
        statusTimer = null;
        paintStatus();
      }, wait);
    }
  };

  /** append-only 输出 flush（33ms 合帧）：自上次 flush 水位后的逻辑行折行上屏。 */
  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const all = session.getLines();
    const omitted = session.getOmitted();
    // 单调全局水位 → snapshot 索引：global index = omitted + i，已 flush 的全局数 = flushedTotal
    const startIndex = Math.max(0, flushedTotal - omitted);
    const fresh = all.slice(startIndex);
    if (fresh.length > 0) {
      flushedTotal = omitted + all.length;
      if (appendScroll) {
        const visual: RenderLine[] = [];
        for (const l of fresh) {
          for (const piece of wrapText(l.text, layout.width)) {
            visual.push({ text: piece, kind: l.kind });
          }
        }
        writeOut(layout.paintLines(visual));
      } else {
        // 降级（backend#15 预案）：全量重绘可见区（绝对定位逐行重写，不靠 \r\n 滚动）
        writeOut(
          layout.repaint(statusString(), session.renderVisible(layout.width, layout.regionHeight)),
        );
      }
      opts.onBottomRow?.();
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, flushMs);
  };

  /** 系统行注入 + 立即调度 flush（FE#2：无数据事件时 notice 仍上屏；只 addSystemLine 不落盘） */
  const injectSystemLine = (text: string): void => {
    session.addSystemLine(text);
    scheduleFlush();
  };

  const clearTimers = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (statusTimer !== null) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };

  const finalize = (code: number): void => {
    if (finalized) return;
    finalized = true;
    clearTimers();
    session.markExit(code);
    flush(); // 剩余输出
    paintStatus(); // 终态状态条（含退出码/耗时定格）
    resolveDone?.(code);
  };

  // ── spawn + 事件接线 ──

  let spawnFailure: unknown = null;
  try {
    child = deps.spawnPi();
  } catch (err) {
    spawnFailure = err;
  }
  if (child === null || spawnFailure !== null) {
    session.addSystemLine(`❌ pi 启动失败: ${String(spawnFailure)}`);
    finalize(127);
    return {
      child: null,
      session,
      layout,
      done,
      close: clearTimers,
      sendCommand: () => {},
      injectUserMessage: () => {},
      injectSystemLine,
    };
  }

  child.on("exit", (code, signal) => {
    finalize(computeExitCode(code, signal));
  });
  child.on("error", (err) => {
    session.addSystemLine(`❌ pi 启动失败: ${String(err)}`);
    finalize(127);
  });

  // steer 写纪律（spike §E）：stdin error handler + 每写 callback 检查 err；
  // EPIPE/ERR_STREAM_DESTROYED/ERR_STREAM_WRITE_AFTER_END 三码收敛为状态条提示，
  // 不抛未捕获异常（否则 exit handler 反杀 pi，故障放大）。
  const markSteerClosed = (): void => {
    session.setSteerClosed(true);
    requestStatus();
  };
  try {
    child.stdin.on?.("error", markSteerClosed);
  } catch {
    // 假实现无 on：跳过
  }

  const sendCommand = (obj: unknown): void => {
    if (child === null || finalized) return;
    try {
      child.stdin.write(JSON.stringify(obj) + "\n", (err?: unknown) => {
        if (err !== undefined && err !== null) markSteerClosed();
      });
    } catch {
      markSteerClosed();
    }
  };

  const injectUserMessage = (message: string): void => {
    // 64K 上限（spike §E backend#6 防呆）：超长 steer 拒发，不写 stdin（不做背压队列）。
    if (utf8ByteLength(message) > MAX_STEER_BYTES) {
      session.addSystemLine("⚠ steer 过长（>64K）未发送");
      scheduleFlush(); // 系统行需 flush 上屏（无数据事件驱动）
      return;
    }
    session.clearSteerFeedback(); // 新一轮 steer 重置上一条「被拒」提示
    if (session.settled) {
      // §Q4 定值：settled 后 steer 只入队不触发（实测 15s+ 无回合）→ 改用 prompt
      // 注入（非流式态立即触发新回合，滞留 steer 会先送达）
      sendCommand({ type: "prompt", message });
    } else {
      // 乐观瞬态（票 06 追加）：先置「已发送」并立即刷新状态条（不经 500ms 节流），
      // 等 queue_update 回来再精确成「排队 N」。
      session.setSteerSent();
      paintStatus();
      sendCommand({ type: "steer", message });
    }
  };

  const input = deps.input ?? child.stdout;
  // 合帧用 StringDecoder（多字节跨 chunk 边界续拼；字符串 chunk 原样透传）。
  const decoder = new StringDecoder("utf8");
  input.on("data", (chunk) => {
    session.consume(decoder.write(chunk));
    requestStatus();
    scheduleFlush();
  });
  input.on("error", () => {
    // 事件流错误：exit 事件兜底终态（pi 死 stdout 必 EOF）
  });
  input.on("end", () => {
    const rest = decoder.end();
    if (rest !== "") session.consume(rest);
    // EOF：等 exit 事件
  });

  // 初始 prompt 注入（rpc 模式无位置参数注入，spike 定案 A2）
  // TD3：resume 传 prompt:'' 时跳过发送，避免 jsonl 出现空 user message
  if (safePrompt !== "") sendCommand({ type: "prompt", message: safePrompt });

  // 静默态：长 thinking 无输出 = 状态条耗时继续走（1s tick 驱动 requestStatus，
  // 500ms 节流兜底）
  tickTimer = setInterval(() => {
    requestStatus();
  }, tickMs);

  // ── 首屏（首状态条 + 首屏行；含 "等待首个事件…"） ──
  writeOut(layout.setup());
  writeOut(
    layout.repaint(statusString(), session.renderVisible(layout.width, layout.regionHeight)),
  );
  // R#16：首屏三行已由 repaint 上屏，把 flush 水位提到当前全局行数，避免首个
  // 数据事件的 flush 把首屏三行重复绘制到区顶部下一段。
  flushedTotal = session.getOmitted() + session.getLines().length;
  lastStatusPaint = nowFn();
  opts.onBottomRow?.();

  // SIGWINCH 四件套：重设滚动区 + 状态条重绘 + 可见区按新宽重折行 + onBottomRow 重绘输入行
  try {
    (deps.onResize ?? defaultOnResize)(() => {
      layout.setSize(getSize());
      writeOut(
        layout.repaint(statusString(), session.renderVisible(layout.width, layout.regionHeight)),
      );
      lastStatusPaint = nowFn();
      opts.onBottomRow?.();
    });
  } catch {
    // 无 resize 面：忽略
  }

  return {
    child,
    session,
    layout,
    done,
    close: clearTimers,
    sendCommand,
    injectUserMessage,
    injectSystemLine,
  };
}
