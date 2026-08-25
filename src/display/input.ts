// src/display/input.ts
// 票 05：pane 内 steer 输入行接线（raw + readline）。零 node: import（readline 由
// 依赖注入 → 纯可测）；readline 私有 API 红线（answerer 定值）：只允许
// prompt(preserveCursor)/setPrompt/on("line"|"SIGINT")/close()，禁
// _refreshLine/_moveCursor/_getCursorPos/_ttyWrite 等私有方法（node 升级震荡会静默破坏）。
//
// 设计（think-first answerer 收敛）：
//   - wireInputLine(deps) 是唯一 readline 落点，控制逻辑纯函数化；createInterface
//     注入，测试用 fake rl 工厂，生产用 readline.createInterface({terminal:true})。
//   - ⚠️① 实测 Node 22.23.2：createInterface({terminal:true}) 自动 setRawMode（isRaw
//     =true），故不显式调 setRawMode/emitKeypressEvents；唯一守卫 = isTTY（直启渲染器
//     无 /dev/tty 绑定 → fd0 非 tty → 返回 null 降级纯渲染，不崩）。
//   - ctrl+C：raw 模式禁用 ISIG，进程收不到 SIGINT 信号，ctrl+C 只走 readline 的
//     SIGINT 事件 → onAbort（幂等，连按两次只触发一次）→ render-mini 里 close +
//     teardown（killTree）+ exit(130)。
//
// 票 09 #7 阶段 B（E2E 发现 Bug #1 撕裂降级）：readline 在 pane 内输入长于 cols
// 的单行时会折行撕裂上方已渲染输出（状态条重复、历史行丢失、scrollback 不可恢复）。
// 故新增 wireFixedInputLine(deps)（纯注入可单测，与 wireInputLine 并列）：读 raw 键序
// （注入 onKey 源），单行 buffer；渲染用绝对定位 `\x1b[<rows>;1H\x1b[2K` + prompt +
// buffer 尾部（单行横向截断到 cols，绝不触发终端折行 → 无 prevRows/多行 wrap/撕裂）。

import { charWidth } from "./primitives.ts";
import type { TermSize } from "./types.ts";

export interface ReadlineLike {
  on(event: "line", listener: (line: string) => void): unknown;
  on(event: "SIGINT", listener: () => void): unknown;
  prompt(preserveCursor?: boolean): void;
  setPrompt(prompt: string): void;
  close(): void;
}

export interface InputLineHandle {
  /** 重绘输入行（rl.prompt(true)）——runRenderer 的 onBottomRow 钩子直调 */
  prompt(): void;
  close(): void;
}

export interface WireInputLineDeps {
  /** fd0 是否 tty（生产 = process.stdin.isTTY；假 → 返回 null 无输入行） */
  isTTY: boolean;
  /** readline 工厂注入：真实 = readline.createInterface({input,output,terminal,prompt}) */
  createInterface: (opts: { terminal: boolean; prompt: string }) => ReadlineLike;
  /** 提交回调（line → handle.injectUserMessage） */
  onLine: (line: string) => void;
  /** ctrl+C 回调（幂等由本函数保证） */
  onAbort: () => void;
  /** 输入行 prompt 文案（缺省 "steer> "） */
  prompt?: string;
}

export function wireInputLine(deps: WireInputLineDeps): InputLineHandle | null {
  if (!deps.isTTY) return null;
  const prompt = deps.prompt ?? "steer> ";
  const rl = deps.createInterface({ terminal: true, prompt });
  let aborted = false;
  rl.on("line", (line) => {
    if (aborted) return;
    deps.onLine(line);
  });
  rl.on("SIGINT", () => {
    if (aborted) return;
    aborted = true; // 幂等：连按两次 ctrl+C 只触发一次 abort
    deps.onAbort();
  });
  return {
    prompt: () => rl.prompt(true),
    close: () => rl.close(),
  };
}

// ── 固定底部输入行（票 09 #7 阶段 B：超宽折行撕裂降级） ────────────────────────

export interface WireFixedInputLineDeps {
  /** fd0 是否 tty（假 → 返回 null 无输入行，直启降级纯渲染） */
  isTTY: boolean;
  /**
   * 订阅 raw 键数据：cb 收到 UTF-8 字符串块（可能含多键/粘贴），返回退订函数。
   * 生产 = stdin raw 模式 + data 事件；测试注入 fake 源。
   */
  onKey: (cb: (chunk: string) => void) => () => void;
  /** 写渲染输出（生产 = process.stdout.write） */
  write: (s: string) => void;
  /** 终端尺寸：rows 定最底行绝对定位，cols 定单行横向截断上限 */
  getSize: () => TermSize;
  /** 提交回调（Enter → onLine(buffer)） */
  onLine: (line: string) => void;
  /** Ctrl+C 回调（幂等由本函数保证） */
  onAbort: () => void;
  /** 输入行 prompt 文案（缺省 "steer> "） */
  prompt?: string;
}

/** 码点显示宽度和（CJK/emoji=2、组合符=0，charWidth 口径）。 */
function displayWidth(text: string): number {
  let w = 0;
  for (const cp of text) w += charWidth(cp);
  return w;
}

/** 取 buffer 尾部，使其显示宽度 ≤ maxWidth（从右向左贪婪保留，宽字符感知）。 */
function tailToFit(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const cps = Array.from(text);
  const kept: string[] = [];
  let w = 0;
  for (let i = cps.length - 1; i >= 0; i--) {
    const cw = charWidth(cps[i]);
    if (w + cw > maxWidth) break;
    kept.unshift(cps[i]);
    w += cw;
  }
  return kept.join("");
}

/** 删末一个码点（代理对/CJK 正确退格）。 */
function backspace(text: string): string {
  const cps = Array.from(text);
  cps.pop();
  return cps.join("");
}

/**
 * 固定底部输入行：单行 buffer + 绝对定位最底行渲染（`\x1b[<rows>;1H\x1b[2K`）+
 * 单行横向截断到 cols（绝不触发终端折行）。键处理：可打印追加 / Backspace(0x7f
 * 或 0x08) / Enter(\r 或 \n)→onLine / Ctrl+C(0x03)→onAbort；其余控制符忽略。
 */
export function wireFixedInputLine(deps: WireFixedInputLineDeps): InputLineHandle | null {
  if (!deps.isTTY) return null;
  const prompt = deps.prompt ?? "steer> ";
  let buffer = "";
  let aborted = false;
  let closed = false;

  const render = (): void => {
    const size = deps.getSize();
    const rows = Number.isFinite(size.rows) && size.rows >= 1 ? Math.floor(size.rows) : 1;
    const cols = Number.isFinite(size.cols) && size.cols >= 1 ? Math.floor(size.cols) : 1;
    const available = Math.max(0, cols - displayWidth(prompt));
    deps.write(`\x1b[${rows};1H\x1b[2K${prompt}${tailToFit(buffer, available)}`);
  };

  const unsubscribe = deps.onKey((chunk) => {
    for (const cp of chunk) {
      if (aborted || closed) return;
      const c = cp.codePointAt(0)!;
      if (cp === "\r" || cp === "\n") {
        const line = buffer;
        buffer = "";
        deps.onLine(line);
      } else if (cp === "\x03") {
        aborted = true; // 幂等：连按两次 ctrl+C 只触发一次 abort
        deps.onAbort();
        return;
      } else if (cp === "\x7f" || cp === "\x08") {
        buffer = backspace(buffer);
      } else if (c < 0x20 || c === 0x7f) {
        continue; // 其余控制字符忽略
      } else {
        buffer += cp;
      }
    }
    if (!aborted && !closed) render();
  });

  render(); // 初始空行 prompt

  return {
    prompt: () => {
      if (aborted || closed) return;
      render();
    },
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    },
  };
}
