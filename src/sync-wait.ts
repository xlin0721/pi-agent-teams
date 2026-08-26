// src/sync-wait.ts — 同步等待器（票 02：spawn sync:true 的等待核心）
//
// 纯逻辑模块，零 SDK import（node: 内置 + 相对 .ts 类型），可单测（fake store + timer 注入）。
// 职责：wait(taskId) 阻塞至任务终态并取回结果；事件钩子（registerDone，wireFarm 终态旁挂）
// 为主通道（低延迟），共享轮询 ticker 兜底（事件丢失/进程重启防漏）。
//
// 契约（spec「结构性缓冲」）：任何路径要么返回完整结果，要么返回带 unfinished:true 的
// 未完成快照 + 指引——绝不抛异常、绝不静默成功、绝不无限挂。
//
// 终态口径：与 farm.ts isTerminalStatus 同口径（done/aborted/failed/cancelled 为终态；
// timeout 非终态——迁移表 timeout×retry→queued 可复活，不作为 wait 终态）。
// 评审 R10：信号文件命中终态时 task record 可能仍 running → status 由信号推导。
// 评审 R11：cost 来源 = task.result.cost（done 时由 queue 从 usage sidecar 填充）；
//           缺失回退读 usage/<id>.json sidecar，不得静默为 0。
// 评审 R7：shutdown() 清理全部 waiter + 停共享 ticker（session_shutdown 调用）。

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Cost, TaskRecord, TaskStore } from "./task-core/store.ts";
import type { TaskStatus } from "./task-core/states.ts";

/** 终态集合（与 farm.ts isTerminalStatus 同口径，注释锚定：farm.ts:84）。 */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "done",
  "aborted",
  "failed",
  "cancelled",
]);

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** wait 返回形状（spec：{taskId, status, exitCode, sessionDir, result, cost, waitedMs, unfinished, timeout}） */
export interface WaitOutcome {
  taskId: string;
  /** 终态（或超时/abort 时的当前状态，见 unfinished） */
  status: TaskStatus;
  exitCode: number | null;
  sessionDir: string;
  /** .result summary（wrapper 截写）；未写入/回退时 = "" */
  result: string;
  cost: Cost;
  waitedMs: number;
  /** true = 未完成（超时/abort/任务消失），调用方必须按快照处理，不得当成功 */
  unfinished: boolean;
  /** true = 超时触发；false = abort/其他（unfinished:false 时无意义） */
  timeout: boolean;
  /** 任务记录缺失（未入队/已 GC）→ true，返回失败而非死等（评审 R6） */
  missing: boolean;
  /** 结果来源：.result | jsonl 回退 | ""（评审 R2：不一致回退 jsonl 原文并标注） */
  resultSource: ".result" | "jsonl-fallback" | "none";
}

export interface WaiterDeps {
  store: TaskStore;
  farmRoot: string;
}

export interface WaitOptions {
  /** 等待超时 ms（缺省 120_000） */
  timeoutMs?: number;
  /** 外部取消（模型 abort / 用户 Ctrl+C） */
  signal?: AbortSignal;
  /** 心跳出口（execute 的 onUpdate；节流 heartbeatIntervalMs 一次） */
  onProgress?: (message: string) => void;
  /** 测试注入：轮询间隔 ms（缺省 500） */
  pollIntervalMs?: number;
  /** 测试注入：心跳节流 ms（缺省 2000） */
  heartbeatIntervalMs?: number;
  /** 测试注入：时钟（epoch ms；缺省 Date.now） */
  now?: () => number;
}

export interface Waiter {
  /** 阻塞至终态/超时/abort/任务消失，返回 WaitOutcome（不抛） */
  wait(taskId: string, opts?: WaitOptions): Promise<WaitOutcome>;
  /** wireFarm 终态事件旁挂（主通道）：触发该任务立即检查一次（低延迟 resolve） */
  registerDone(taskId: string): void;
  /** consumed 去重查询：是否有 waiter 正在等待该任务（覆盖整个等待窗口，评审 R1①） */
  isWaiting(taskId: string): boolean;
  /** abort 清理：resolve 未完成快照 + 删条目（评审 R7；任务终止归既有取消通道） */
  cancel(taskId: string): Promise<WaitOutcome | null>;
  /** session_shutdown：停共享 ticker + 全部 resolve 未完成快照 + 清表 */
  shutdown(): void;
}

interface Pending {
  taskId: string;
  resolve: (outcome: WaitOutcome) => void;
  startedAt: number;
  timeoutMs: number;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
  onProgress: ((message: string) => void) | null;
  heartbeatIntervalMs: number;
  lastProgressAt: number;
  done: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;

/** 从 session jsonl 全文提取最终答案（评审 R2 锚点）：最后一条 type=message +
 *  role=assistant + content[].type=text 的完整文本（message_update delta 不取），
 *  截断 8KB。与 wrapper.sh write_result 的 node 内联提取同口径（双轨 diff 测试锚点）。
 */
export function extractSummaryFromJsonl(raw: string): string {
  let best = "";
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r === null || typeof r !== "object") continue;
    const rec = r as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (
      rec.type === "message" &&
      rec.message !== null &&
      typeof rec.message === "object" &&
      rec.message.role === "assistant" &&
      Array.isArray(rec.message.content)
    ) {
      const texts = (rec.message.content as unknown[])
        .filter(
          (p): p is { type: "text"; text: string } =>
            p !== null &&
            typeof p === "object" &&
            (p as { type?: unknown }).type === "text" &&
            typeof (p as { text?: unknown }).text === "string",
        )
        .map((p) => p.text);
      if (texts.length > 0) best = texts.join("\n");
    }
  }
  return best.slice(0, 8192);
}

/** session jsonl 全文 sha256（对拍校验用；与 wrapper write_result 的 sha256 同口径）。 */
export function sha256Of(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** 读 sessionDir 下最新 jsonl 全文（不存在/不可读 → null）。 */
async function readLatestJsonl(sessionDir: string): Promise<string | null> {
  if (sessionDir === "") return null;
  try {
    const files = await readdir(sessionDir);
    const jsonls = files.filter((f: string) => f.endsWith(".jsonl"));
    if (jsonls.length === 0) return null;
    // 文件名带 UTC 时间戳前缀，字典序 = 时间序（倒序取最新）
    jsonls.sort();
    return await readFile(join(sessionDir, jsonls[jsonls.length - 1]), "utf8");
  } catch {
    return null;
  }
}

/** 终态读取：task record / 信号文件 / .result → 归一化 WaitOutcome 数据。 */
async function readTerminal(
  store: TaskStore,
  farmRoot: string,
  taskId: string,
  now: number,
): Promise<Omit<WaitOutcome, "waitedMs" | "unfinished" | "timeout"> | null> {
  const task = await store.readTask(taskId);
  let status: TaskStatus = task?.status ?? "queued";
  let exitCode: number | null = task?.result?.exitCode ?? null;
  let sessionDir = task?.result?.sessionDir ?? "";
  let cost: Cost = task?.result?.cost ?? { model: "", inputTokens: 0, outputTokens: 0 };
  let missing = task === null;

  // 信号文件优先于 record（迟到信号修正；评审 R10：status 由信号推导）
  const signal = await store.readStatusSignal(taskId);
  if (signal !== null) {
    if (signal.kind === "done") {
      status = "done";
      exitCode = signal.exitCode;
      sessionDir = signal.sessionDir;
    } else {
      status = "aborted";
    }
  }

  // .result 文件（wrapper 截写）：存在即 done（评审 R10 信号面补全）
  let result = "";
  let resultSource: WaitOutcome["resultSource"] = "none";
  let resultExists = false;
  try {
    const resultPath = join(farmRoot, "status", `${taskId}.result`);
    const st = await stat(resultPath);
    resultExists = st.isFile();
    if (resultExists) {
      const parsed: unknown = JSON.parse(await readFile(resultPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        const summary = (parsed as { summary?: unknown }).summary;
        if (typeof summary === "string") {
          result = summary;
          resultSource = ".result";
          if (status !== "aborted" && status !== "failed" && status !== "cancelled") {
            status = "done";
            const ec = (parsed as { exitCode?: unknown }).exitCode;
            const sd = (parsed as { sessionDir?: unknown }).sessionDir;
            if (typeof ec === "number") exitCode = ec;
            if (typeof sd === "string" && sd !== "") sessionDir = sd;
          }
          // 对拍校验（评审 R2）：sha256 与 session jsonl 全文不一致 → 回退 jsonl 提取原文
          const wantSha = (parsed as { sha256?: unknown }).sha256;
          if (typeof wantSha === "string" && wantSha !== "") {
            const raw = await readLatestJsonl(sessionDir);
            if (raw !== null && sha256Of(raw) !== wantSha) {
              const fallback = extractSummaryFromJsonl(raw);
              if (fallback !== "") {
                result = fallback;
                resultSource = "jsonl-fallback";
              }
            }
          }
        }
      }
    }
  } catch {
    // .result 缺失/不可读 → 非终态信号，忽略
  }

  // cost 回退：usage sidecar（评审 R11）
  if (cost.model === "" && (cost.inputTokens === 0 && cost.outputTokens === 0)) {
    try {
      const usagePath = join(farmRoot, "usage", `${taskId}.json`);
      const parsed: unknown = JSON.parse(await readFile(usagePath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        const p = parsed as { model?: unknown; inputTokens?: unknown; outputTokens?: unknown };
        cost = {
          model: typeof p.model === "string" ? p.model : "",
          inputTokens: typeof p.inputTokens === "number" ? p.inputTokens : 0,
          outputTokens: typeof p.outputTokens === "number" ? p.outputTokens : 0,
        };
      }
    } catch {
      // usage 缺失 → 保持 0
    }
  }

  void now;
  return { taskId, status, exitCode, sessionDir, result, resultSource, cost, missing };
}

/** 终态判定（单一事实源，事件/轮询共用）：是终态 → outcome；否则 null。 */
async function tryTerminal(
  store: TaskStore,
  farmRoot: string,
  taskId: string,
  now: number,
): Promise<Omit<WaitOutcome, "waitedMs" | "unfinished" | "timeout"> | null> {
  const task = await store.readTask(taskId);
  // 任务记录缺失：未入队（降级门拒绝在 writeTask 之前）/ 已 GC → 返回失败不死等（评审 R6）
  if (task === null) {
    return {
      taskId,
      status: "failed",
      exitCode: null,
      sessionDir: "",
      result: "",
      resultSource: "none",
      cost: { model: "", inputTokens: 0, outputTokens: 0 },
      missing: true,
    };
  }
  if (isTerminalStatus(task.status)) {
    return readTerminal(store, farmRoot, taskId, now);
  }
  // 非终态（queued/running/timeout）：信号文件 / .result 命中 → 终态（迟到修正）
  const signal = await store.readStatusSignal(taskId);
  if (signal !== null) {
    return readTerminal(store, farmRoot, taskId, now);
  }
  // .result 存在（wrapper 已截写但 record 状态迁移滞后）
  try {
    const st = await stat(join(farmRoot, "status", `${taskId}.result`));
    if (st.isFile()) return readTerminal(store, farmRoot, taskId, now);
  } catch {
    // 无 .result
  }
  return null;
}

export function createWaiter(deps: WaiterDeps): Waiter {
  const pending = new Map<string, Pending>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let nowFn: () => number = Date.now;

  function emitProgress(p: Pending, now: number): void {
    if (p.onProgress === null) return;
    if (now - p.lastProgressAt < p.heartbeatIntervalMs) return;
    p.lastProgressAt = now;
    const elapsed = now - p.startedAt;
    const total = Math.round(p.timeoutMs / 1000);
    try {
      p.onProgress(`[sync-wait] 仍在等待任务 ${p.taskId.slice(0, 8)}，已耗时 ${(elapsed / 1000).toFixed(1)}s（超时 ${total}s）`);
    } catch {
      // onUpdate 抛错不阻断等待
    }
  }

  async function settle(p: Pending, partial: Omit<WaitOutcome, "waitedMs" | "unfinished" | "timeout">, unfinished: boolean, timeout: boolean, forcedWaitedMs?: number): Promise<void> {
    if (p.done) return;
    p.done = true;
    if (p.timeoutTimer !== null) clearTimeout(p.timeoutTimer);
    if (p.onAbort !== null && p.signal !== null) {
      try {
        p.signal.removeEventListener("abort", p.onAbort);
      } catch {
        // 忽略
      }
    }
    const outcome: WaitOutcome = {
      ...partial,
      waitedMs: forcedWaitedMs ?? (nowFn() - p.startedAt),
      unfinished,
      timeout,
    };
    pending.delete(p.taskId);
    p.resolve(outcome);
  }

  /** 单任务立即检查一次（事件钩子/轮询共用） */
  async function checkNow(taskId: string): Promise<void> {
    const p = pending.get(taskId);
    if (p === undefined || p.done) return;
    const now = nowFn();
    emitProgress(p, now);
    const terminal = await tryTerminal(deps.store, deps.farmRoot, taskId, now);
    if (terminal !== null) {
      await settle(p, terminal, false, false);
    }
  }

  /** 共享轮询 ticker（防轮询风暴：单 ticker 驱动全部 waiter，评审 R6 轮询风暴对策） */
  function startPolling(): void {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      const ids = [...pending.keys()];
      for (const id of ids) {
        void checkNow(id);
      }
    }, pollIntervalMs);
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    async wait(taskId: string, opts: WaitOptions = {}): Promise<WaitOutcome> {
      const now = nowFn();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const hb = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
      pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      if (typeof opts.now === "function") nowFn = opts.now;

      // 注册 waiter（wait 开始即注册，覆盖整个等待窗口含 pre 检查，评审 R1①）
      let resolve!: (o: WaitOutcome) => void;
      const promise = new Promise<WaitOutcome>((r) => {
        resolve = r;
      });
      const p: Pending = {
        taskId,
        resolve,
        startedAt: now,
        timeoutMs,
        timeoutTimer: null,
        signal: opts.signal ?? null,
        onAbort: null,
        onProgress: opts.onProgress ?? null,
        heartbeatIntervalMs: hb,
        lastProgressAt: 0,
        done: false,
      };
      pending.set(taskId, p);

      // pre 检查：已终态 / 任务缺失 → 立即 settle（避免无谓进入等待）
      const pre = await tryTerminal(deps.store, deps.farmRoot, taskId, now);
      if (pre !== null) {
        // pre 命中：未实际等待，waitedMs 强制 0（无谓 pre 检查耗时不计入）
        await settle(p, pre, pre.missing, false, 0);
      }

      // 超时定时器：超时 → 未完成快照（不杀任务，可 farm_status/farm_resume）
      p.timeoutTimer = setTimeout(() => {
        const partial: Omit<WaitOutcome, "waitedMs" | "unfinished" | "timeout"> = {
          taskId,
          status: "timeout",
          exitCode: null,
          sessionDir: "",
          result: "",
          resultSource: "none",
          cost: { model: "", inputTokens: 0, outputTokens: 0 },
          missing: false,
        };
        void settle(p, partial, true, true);
      }, timeoutMs);

      // abort：快速脱身（≤1s 目标），不杀 pane（任务继续跑，归既有取消通道）
      if (opts.signal !== null && opts.signal !== undefined) {
        const onAbort = () => {
          const partial: Omit<WaitOutcome, "waitedMs" | "unfinished" | "timeout"> = {
            taskId,
            status: "running",
            exitCode: null,
            sessionDir: "",
            result: "",
            resultSource: "none",
            cost: { model: "", inputTokens: 0, outputTokens: 0 },
            missing: false,
          };
          void settle(p, partial, true, false);
        };
        p.onAbort = onAbort;
        if (opts.signal.aborted) onAbort();
        else {
          try {
            opts.signal.addEventListener("abort", onAbort, { once: true });
          } catch {
            // 不可监听 → 忽略
          }
        }
      }

      startPolling();
      const outcome = await promise;
      if (pending.size === 0) stopPolling();
      return outcome;
    },

    registerDone(taskId: string): void {
      // 主通道：wireFarm 终态事件旁挂——立即检查一次（低延迟 resolve）
      void checkNow(taskId);
    },

    isWaiting(taskId: string): boolean {
      return pending.has(taskId);
    },

    async cancel(taskId: string): Promise<WaitOutcome | null> {
      const p = pending.get(taskId);
      if (p === undefined || p.done) return null;
      const partial: Omit<WaitOutcome, "waitedMs" | "unfinished" | "timeout"> = {
        taskId,
        status: "running",
        exitCode: null,
        sessionDir: "",
        result: "",
        resultSource: "none",
        cost: { model: "", inputTokens: 0, outputTokens: 0 },
        missing: false,
      };
      await settle(p, partial, true, false);
      if (pending.size === 0) stopPolling();
      return {
        ...partial,
        waitedMs: nowFn() - p.startedAt,
        unfinished: true,
        timeout: false,
      };
    },

    shutdown(): void {
      stopPolling();
      const ids = [...pending.keys()];
      for (const id of ids) {
        const p = pending.get(id);
        if (p === undefined || p.done) continue;
        const partial: Omit<WaitOutcome, "waitedMs" | "unfinished" | "timeout"> = {
          taskId: id,
          status: "running",
          exitCode: null,
          sessionDir: "",
          result: "",
          resultSource: "none",
          cost: { model: "", inputTokens: 0, outputTokens: 0 },
          missing: false,
        };
        void settle(p, partial, true, false);
      }
      pending.clear();
    },
  };
}
