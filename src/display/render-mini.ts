// src/display/render-mini.ts
// B 形态渲染器薄入口装配（票 04）：读 env + task record → 拼 pi args → spawn 无头 pi
// （pipe stdio；stdout=事件流、stdin=rpc 命令通道、stderr→/dev/null）→ runRenderer
// 接管 pane 面 → pi 退出码即渲染器退出码。
//
// 权威事实来源：.scratch/m2.5-b-form/spike-facts-m25.md（T0 定案 A2）+ 票 04 票面。
//   - 定案命令形态：pi -p --mode rpc --session-dir <S> --approve（-p 在 mode=rpc 下被
//     mode 决议覆盖，保留与 spike 实测命令完全一致）；初始任务走 stdin
//     {"type":"prompt","message":...} 行注入（rpc 无位置参数注入）。
//   - pi stderr → /dev/null（spike §K4 实测含用户级扩展告警行，必吞防污染 ANSI 面）；
//     渲染器自身 stderr 继承 pane（崩溃诊断可见）。
//   - spawn 'error'（ENOENT/参数错）→ runRenderer 写明文诊断 → exit 127。
//   - 退出语义：pi close → exit(pi 真实退出码)（信号死 128+n）；exit/SIGTERM/SIGHUP
//     handler 先递归树杀 pi 再退（收尸兜底①，backend#3：pgrep -P 逐层 TERM，
//     wrapper kill_tree 同款；pi 被 TERM 自清工具子进程已实测，树杀=双保险）。
//   - 崩溃诊断：uncaughtException → 写 stderr 留痕 → 树杀 → exit 134（SIGABRT 口径，票 09 #6）。
//   - 入口守卫：node 22 type-stripping 无 import.meta.main——argv[1] 与
//     import.meta.url 同文件才执行 main()，测试 import 本模块不触发入口副作用。
// 零第三方、零 pi SDK import：node: 内置 + 相对导入 .ts。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { runRenderer } from "./render-core.ts";
import type { PiChild, RendererHandle, TermSize } from "./render-core.ts";
import { stripAnsiText, truncateTo } from "./primitives.ts";
import { wireFixedInputLine, wireInputLine } from "./input.ts";
import type { InputLineHandle, ReadlineLike } from "./input.ts";
import { pollInbox, type PollSink } from "../comm/inbox.ts";
import { formatClockTime, type ResolvePaneIdOptions } from "../steer-tool.ts";

// ── 纯函数（可单测） ────────────────────────────────────────────────────────

export interface PiArgInput {
  sessionDir: string;
  /** "" → 不带 --name（PRD §13.1 D8：空 role 无 --name） */
  role: string;
  /** "" → 无 persona；存在性由装配层读盘后传入 */
  personaFile: string;
  personaExists: boolean;
  /** 票 08：非空 → resume（--session 替代 prompt 注入，D8 不重注入 persona） */
  resumeFrom?: string;
}

/**
 * pi args 拼装（spike 定案 A2）：["-p", "--mode", "rpc", "--session-dir", <S>,
 * (--append-system-prompt <F>), (--name <role>), "--approve"]。--approve 恒带
 * （spike §F1：无 UI 可用时项目 .pi/ 资源唯一加载门）。
 * 票 08 resume：resumeFrom 非空 → --session 替代 prompt/persona/--name（会话名幂等，
 * 无需重复设置；与 wrapper.sh TUI resume 分支不带 --name 口径一致）。
 */
export function buildPiArgs(input: PiArgInput): string[] {
  const args = ["-p", "--mode", "rpc", "--session-dir", input.sessionDir];
  if (typeof input.resumeFrom === "string" && input.resumeFrom !== "") {
    args.push("--session", input.resumeFrom);
  } else {
    if (input.personaFile !== "" && input.personaExists) {
      args.push("--append-system-prompt", input.personaFile);
    }
    if (input.role !== "") args.push("--name", input.role);
  }
  args.push("--approve");
  return args;
}

/** 票 08：resumeFrom 非空 → 不注入原任务 prompt（返回 ""）；否则原 prompt。 */
export function initialPromptFor(resumeFrom: string | undefined, prompt: string): string {
  return resumeFrom !== undefined && resumeFrom !== "" ? "" : prompt;
}

/** 崩溃退出码（票 09 #6）：SIGABRT 口径 128+6=134，与「exit≥128 附异常退出」文案对齐。 */
export const CRASH_EXIT_CODE = 134;

const TITLE_MAX_CHARS = 100;

/** title sanitize（票 09 #5，与 wrapper TUI 分支同口径）：剥 ANSI/控制符 + 截断。 */
export function sanitizeTitle(text: string): string {
  return truncateTo(stripAnsiText(text).replace(/[\u0000-\u001f\u007f]/g, ""), TITLE_MAX_CHARS);
}

/**
 * OSC 0 pane 标题：`⏳ <taskId 前 8 位> <TITLE>`（frontend#9：taskId8 前缀保 8 pane
 * 导航，沿用 wrapper ⏳ 口径）。
 */
export function titleSequence(taskId: string, title: string): string {
  return `\x1b]0;⏳ ${stripAnsiText(taskId).slice(0, 8)} ${sanitizeTitle(title)}\x07`;
}

/**
 * 递归树杀（backend#3，wrapper kill_tree 同款 node 实现）：pgrep -P 逐层找子进程
 * 先杀子树再 TERM 自身（process.kill 缺省信号 = SIGTERM）。深度上限 32 防病态环；
 * pgrep 缺失/进程已死静默。pi 被 TERM 自清工具子进程（spike §T）→ 树杀=双保险。
 */
export function killTree(pid: number): void {
  killTreeDepth(pid, 0);
}

function killTreeDepth(pid: number, depth: number): void {
  if (!Number.isFinite(pid) || pid <= 1 || depth > 32) return;
  try {
    const out = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    const stdout = typeof out.stdout === "string" ? out.stdout : "";
    for (const child of stdout.trim().split(/\s+/)) {
      if (child === "") continue;
      const cpid = Number(child);
      if (Number.isInteger(cpid) && cpid > 0) killTreeDepth(cpid, depth + 1);
    }
  } catch {
    // pgrep 缺失：只杀本进程
  }
  try {
    process.kill(pid); // 缺省 SIGTERM
  } catch {
    // 已死
  }
}

// ── task record 读取 ───────────────────────────────────────────────────────

export interface SpawnFields {
  prompt: string;
  role: string;
  /** 耗时锚：task record startedAt（启动时读一次，零写入）；缺失=0 → 渲染器启动时刻 */
  startedAt: number;
  /** split-pane 写回 paneId（票 03：steer 读侧轮询目标）；缺失/空 = 未写回（键省略，
   *  保持 render-core.test.ts 对 readSpawnFields 三字段 deepEqual 的零 diff） */
  paneId?: string;
  /** 票 08：非空则 resume（--session 替代 prompt 注入；键省略 = 新建会话） */
  resumeFrom?: string;
}

/** 读 task record payload.spawn.{prompt,role,paneId} + startedAt（坏文件/缺字段容错，零抛）。 */
export function readSpawnFields(taskRecordPath: string): SpawnFields {
  const fallback: SpawnFields = { prompt: "", role: "", startedAt: 0 };
  try {
    const parsed: unknown = JSON.parse(readFileSync(taskRecordPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return fallback;
    const rec = parsed as Record<string, unknown>;
    const startedAt = rec["startedAt"];
    const payload = rec["payload"];
    const spawn =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>)["spawn"]
        : undefined;
    const out: SpawnFields = { ...fallback };
    if (typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0) {
      out.startedAt = startedAt;
    }
    if (spawn !== null && typeof spawn === "object") {
      const s = spawn as Record<string, unknown>;
      const prompt = s["prompt"];
      const role = s["role"];
      const paneId = s["paneId"];
      const resumeFrom = s["resumeFrom"];
      if (typeof prompt === "string") out.prompt = prompt;
      if (typeof role === "string") out.role = role.trim();
      // paneId/resumeFrom 仅非空才写入键（缺失省略）——保持既有三字段 deepEqual 测试零 diff
      if (typeof paneId === "string" && paneId !== "") out.paneId = paneId;
      if (typeof resumeFrom === "string" && resumeFrom !== "") out.resumeFrom = resumeFrom;
    }
    return out;
  } catch {
    return fallback;
  }
}

// ── 票 03 steer 读侧（B 形态 C 段）：inbox sink + paneId 启动轮询 ────────────

/**
 * B 侧 sink：steer → injectSystemLine(标签行) + injectUserMessage(content)；
 * msg（票 04）→ notice 渲染一行 / directive 同 steer；advance delivered→sink→read
 * 由 pollInbox 内置。
 */
export function buildInboxSink(handle: RendererHandle): PollSink {
  return (msg) => {
    if (msg.type === "steer") {
      const label = `📨 来自 ${stripAnsiText(msg.from)} · ${formatClockTime(msg.ts)}`;
      handle.injectSystemLine(label); // FE#2：静默态 notice 仍上屏
      handle.injectUserMessage(msg.content); // settled→prompt / 否则 steer rpc
      return;
    }
    if (msg.type === "msg") {
      if (msg.delivery === "notice") {
        // FE#2：静默态 notice 仍上屏；换行压成空格防破行
        const content =
          typeof msg.content === "string" ? msg.content.replace(/[\r\n]+/g, " ") : "";
        handle.injectSystemLine(`📨 来自 ${stripAnsiText(msg.from)}: ${content}`);
      } else {
        const label = `📨 来自 ${stripAnsiText(msg.from)} · ${formatClockTime(msg.ts)}`;
        handle.injectSystemLine(label);
        handle.injectUserMessage(msg.content); // settled→prompt / 否则 steer rpc（同票 03）
      }
      return;
    }
  };
}

/**
 * B 侧：轮询读 task record 文件的 payload.spawn.paneId 直到非空；超时返回 ""。
 * 与 steer-tool.ts resolveOwnPaneId（注入 readTask）同一「轮询到非空」语义；
 * 本实现复用 render-mini 已有文件读路径（readSpawnFields），零 TaskStore。
 */
export async function resolvePaneId(
  taskRecordPath: string,
  opts: ResolvePaneIdOptions = {},
): Promise<string> {
  const nowFn = opts.now ?? Date.now;
  const pollMs = typeof opts.pollMs === "number" && opts.pollMs > 0 ? opts.pollMs : 200;
  const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
  const deadline = nowFn() + timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) return "";
    const paneId = readSpawnFields(taskRecordPath).paneId;
    if (typeof paneId === "string" && paneId !== "") return paneId;
    if (nowFn() >= deadline) return "";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// ── 入口 ───────────────────────────────────────────────────────────────────

/** 尺寸（stdout columns/rows；非 TTY 退化 {24,80}）。 */
function paneSize(): TermSize {
  const out = process.stdout as unknown as { columns?: unknown; rows?: unknown };
  const cols = typeof out.columns === "number" && out.columns > 0 ? out.columns : 80;
  const rows = typeof out.rows === "number" && out.rows > 0 ? out.rows : 24;
  return { rows, cols };
}

/**
 * 薄入口：env 契约（wrapper 全量继承）→ task record → pi args → spawn → runRenderer
 * → 退出码。进程级信号/收尸/崩溃诊断全部在本层（render-core 零进程副作用）。
 */
export async function main(): Promise<number> {
  const env = process.env;
  const taskId = env["PI_AGENT_TEAMS_TASK_ID"] ?? "";
  const doneFile = env["DONE_FILE"] ?? "";
  const abortedFile = env["ABORT_FILE"] ?? "";
  const sessDir = env["SESS_DIR"] ?? "";
  const title = env["TITLE"] ?? "";
  const cwd = env["CWD"] ?? "";
  const personaFile = env["PERSONA_FILE"] ?? "";
  const piBin = env["PI_BIN"] ?? "";
  const piScript = env["PI_SCRIPT"] ?? "";

  const fail = (msg: string, code: number): number => {
    try {
      process.stderr.write(`❌ 渲染器启动失败: ${msg}\n`);
    } catch {
      // stderr 不可达：无路可退
    }
    return code;
  };

  if (taskId === "" || sessDir === "") {
    return fail("缺少 PI_AGENT_TEAMS_TASK_ID / SESS_DIR", 2);
  }

  // task record 路径：DONE_FILE（wrapper 契约必有）→ FARM_DIR/tasks/<id>.json
  // （payload.spawn.prompt/role 单点真源，wrapper node -e 同源先例）
  let spawnFields: SpawnFields = { prompt: "", role: "", startedAt: 0 };
  const farmDir =
    doneFile !== "" ? dirname(dirname(doneFile)) : abortedFile !== "" ? dirname(dirname(abortedFile)) : "";
  if (farmDir !== "" && farmDir !== "." && farmDir !== "/") {
    spawnFields = readSpawnFields(join(farmDir, "tasks", `${taskId}.json`));
  }

  const piBinary = piBin !== "" ? piBin : "pi";
  const args = buildPiArgs({
    sessionDir: sessDir,
    role: spawnFields.role,
    personaFile,
    personaExists: personaFile !== "" && existsSync(personaFile),
    resumeFrom: spawnFields.resumeFrom,
  });
  const argv = piScript !== "" ? [piScript, ...args] : args;

  const spawnPi = (): PiChild => {
    const child = spawn(piBinary, argv, {
      cwd: cwd !== "" ? cwd : undefined,
      stdio: ["pipe", "pipe", "ignore"], // stdin=命令通道, stdout=事件流, stderr→/dev/null（spike §K4 必吞）
    });
    return child as unknown as PiChild;
  };

  // OSC 0 pane 标题（渲染面外，直接写 stdout）
  try {
    process.stdout.write(titleSequence(taskId, title));
  } catch {
    // 输出不可达：继续（终态诊断另有路径）
  }

  // 收尸兜底①（评审 R#2：提前注册 + childPid 延迟绑定——信号 handler 必须在 spawn
  // 之前注册，否则 spawn 到 handler 之间的窗口收到 SIGTERM 走默认杀、pi 被 reparent
  // 成孤儿）。normal 完成时 pi 已退出，killTree 幂等。
  let tornDown = false;
  let childPid: number | null = null;
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    if (childPid !== null && childPid > 0) killTree(childPid);
  };
  process.on("exit", teardown);
  process.on("SIGTERM", () => {
    teardown();
    process.exit(143);
  });
  process.on("SIGHUP", () => {
    teardown();
    process.exit(129);
  });
  // 崩溃诊断写 stderr 留痕（frontend#5：stderr 随 wrapper 即时退出会闪失，
  // 此处先留痕再树杀——farm 通知对 exit≥128 附「异常退出」提示）
  process.on("uncaughtException", (err) => {
    try {
      process.stderr.write(`❌ 渲染器崩溃: ${String(err)}\n`);
    } catch {
      // stderr 不可达：无路可退
    }
    teardown();
    process.exit(CRASH_EXIT_CODE);
  });

  // 票 05：输入行句柄先声明（onBottomRow 闭包引用；runRenderer 初始 repaint 时
  // 仍为 null → 无操作，首屏后首个 prompt 见下）
  let input: InputLineHandle | null = null;

  const handle = runRenderer(
    {
      input: null, // 事件源 = pi stdout
      output: {
        write: (s: string) => {
          process.stdout.write(s);
          return true;
        },
      },
      spawnPi,
    },
    {
      taskId,
      role: spawnFields.role,
      prompt: initialPromptFor(spawnFields.resumeFrom, spawnFields.prompt),
      startedAt: spawnFields.startedAt,
      getSize: paneSize,
      onBottomRow: () => input?.prompt(),
      appendScroll: env["PI_RENDERER_NO_SCROLL"] !== "1",
    },
  );
  // spawn 后立即回填 childPid（runRenderer 内同步 spawnPi）
  childPid = typeof handle.child?.pid === "number" && handle.child.pid > 0 ? handle.child.pid : null;

  // 票 09 #7 阶段 B（E2E 发现 Bug #1：超宽输入折行撕裂 prevRows）：默认翻转固定
  // 底部输入行 wireFixedInputLine（绝对定位最底行 + 单行横向截断，绝不触发终端折行
  // → 无 prevRows/多行 wrap/撕裂）。读 raw 键序（setRawMode + data 事件），isTTY 假
  // → 返回 null 降级纯渲染，直启渲染器不崩。遗留 readline 路径保留为逃逸闸门：
  // PI_RENDERER_FIXED_INPUT=0 时走 wireInputLine（raw 由 readline terminal:true 自动置位）。
  type RawStdin = {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
    setEncoding?: (enc: string) => unknown;
    resume?: () => unknown;
    on?: (event: string, listener: (chunk: unknown) => void) => unknown;
    off?: (event: string, listener: (chunk: unknown) => void) => unknown;
  };
  const stdin = (process as unknown as { stdin: RawStdin }).stdin;
  const onAbortInput = (): void => {
    input?.close();
    teardown();
    process.exit(130);
  };
  if (env["PI_RENDERER_FIXED_INPUT"] === "0") {
    input = wireInputLine({
      isTTY: stdin.isTTY === true,
      createInterface: (o) =>
        readline.createInterface({
          input: stdin,
          output: process.stdout,
          terminal: o.terminal,
          prompt: o.prompt,
        }) as unknown as ReadlineLike,
      onLine: (line) => handle.injectUserMessage(line),
      onAbort: onAbortInput,
    });
  } else {
    input = wireFixedInputLine({
      isTTY: stdin.isTTY === true,
      onKey: (cb) => {
        if (stdin.isTTY !== true) return () => {};
        try {
          stdin.setRawMode?.(true);
          stdin.setEncoding?.("utf8");
          stdin.resume?.();
        } catch {
          // raw/encoding 不可设：仍按行读（控制符可能被行编辑吞掉，退化为普通行读）
        }
        const onData = (chunk: unknown): void => {
          cb(typeof chunk === "string" ? chunk : String(chunk));
        };
        stdin.on?.("data", onData);
        return () => stdin.off?.("data", onData);
      },
      write: (s) => {
        process.stdout.write(s);
      },
      getSize: paneSize,
      onLine: (line) => handle.injectUserMessage(line),
      onAbort: onAbortInput,
    });
  }
  input?.prompt(); // 首屏后首个 prompt（fixed 路径幂等重绘）

  // —— 票 03 steer 读侧：B 形态 worker 自建 400ms inbox 轮询 ——
  // （farmDir 已在上面由 doneFile/abortedFile 派生；resolvePaneId 内部 setTimeout
  //  轮询不阻塞渲染器自身 flush/status/tick 定时器。advance delivered/read 由
  //  pollInbox 内部完成，render-mini 只驱动循环。）
  let inboxTimer: number | null = null;
  if (farmDir !== "" && farmDir !== "." && farmDir !== "/") {
    // 票 03 快速修复：resolvePaneId（默认 30s 轮询）与 handle.done 竞争——pi 启动即
    // 失败/秒退时 handle.done 先 resolve，直接跳过 inbox 装配，避免空转 30s。
    const ac = new AbortController();
    handle.done.then(() => ac.abort());
    const first = await Promise.race([
      resolvePaneId(join(farmDir, "tasks", `${taskId}.json`), { signal: ac.signal }).then(
        (paneId) => ({ paneId }),
      ),
      handle.done.then(() => null),
    ]);
    const inboxPaneId = first?.paneId ?? "";
    if (inboxPaneId !== "") {
      inboxTimer = setInterval(() => {
        void pollInbox(farmDir, inboxPaneId, buildInboxSink(handle));
      }, 400);
    }
  }

  const code = await handle.done;
  if (inboxTimer !== null) clearInterval(inboxTimer);
  input?.close();
  handle.close();
  teardown();
  return code;
}

/** 入口守卫（node 22 type-stripping 无 import.meta.main）：argv[1] 与本文件同路才执行。 */
function isMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (typeof argv1 !== "string" || argv1 === "") return false;
    return argv1 === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      try {
        process.stderr.write(`❌ 渲染器异常: ${String(err)}\n`);
      } catch {
        // stderr 不可达
      }
      process.exit(CRASH_EXIT_CODE);
    },
  );
}
