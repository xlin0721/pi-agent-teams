// src/farm.ts
// farm 循环生命周期（主会话装配层）：400ms ticker、3s pane 存活探测、通知聚合/补发、
// session_shutdown 全 kill + cancelled 落盘、GC tick。纯函数与装配分离：纯部分零副作用
// 可单测（farm.test.ts），装配部分归 08 smoke 实机验证。
//
// 依据：.scratch/m2-background-mode/issues/05-farm-loop.md + PRD-v3.md §13.2/§13.3。
// - ticker：session_start 武装 setInterval(400ms → Queue.step)；回调顶层 try/catch
//   （防旧 pi 引用 assertActive 等异常崩溃自杀）；句柄模块级锚点、start 先清后武装
//   （reload/新会话重武装，不残留双 ticker）。
// - 探测：3s 循环常驻武装期；wezterm list 探测仅存在 running 任务时执行（V6 实测
//   list 单次 ~1.2s，无任务时不白烧 cli 调用）；差集经 Queue.step {paneGone} 注入
//   aborted（tick 注入，不落 status 文件——aborted 文件唯一写者 = wrapper）。
// - 通知：终态事件入缓冲，aggregateEvents 判定 ≥2s 窗口发 1 条；notify 注入出口
//   （T6 接 pi.sendMessage farm.done deliverAs:"followUp" triggerTurn:true）；
//   notifiedAt 在通知发出后写回（notify 抛错不写回 → 下次 session_start 补发兜底）。
// - 补发：session_start 时全量 scanTasks(null)（不做本 owner 预过滤，owner 仲裁全部交
//   filterReplay）→ 终态 + 未通知 + updatedAt≤24h + owner==本进程 或 owner 进程已死
//   （owner pid 经 process.kill(pid,0) 探测：ESRCH=死、EPERM=活；旧格式/缺 owner 保守
//   视为活，仅 owner==本进程可补发）。防双会话重复通知 + quit 重启后跨重启补发（US21）；
//   deliver 写回 notifiedAt 守卫同口径（owner==本进程 或 owner 已死）——死 owner 任务
//   通知后同样写回，防每次重启重复补发。
// - 僵尸回收：session_start 对 owner 进程已死的 running 任务（接管崩溃主会话）先
//   best-effort killSync 僵尸 pane（按 record.paneId，空跳过；可能已死，killSync
//   幂等容忍 no such pane）再以 paneAborted 注入 aborted（与探测 paneGone 同迁移边；
//   owner 已死，无单写者冲突，本进程即接管写者）→ 释放全局 running 并发位（跨
//   owner 共享上限），随后 replay 补发 farm.done（aborted 附恢复命令）。
// - 销毁：session_shutdown 幂等——armed=false 挡新 step 后，有界等 busy 闩排空（只等
//   in-flight step 完成：其 spawn 写回的 paneId 才能被双扫 kill，防关窗后新 pane
//   泄漏；上限 busyDrainTimeoutMs 可注入、默认 5s，挂死 step 不拖垮 shutdown）→
//   killSync 同步全 kill 本会话 running/timeout pane（spawnSync 实现，防异步
//   fire-and-forget 进程退出前未完成；timeout 任务只 kill 不迁移状态，下次会话
//   retry 自然接管；kill 不删 session 文件，sessions 由 GC 7d 口径回收）+ running/
//   queued cancelled 落盘（每任务落盘前 readTask 现读，防 stale 快照整记录写回
//   clobber 并发 spawn 写回的 paneId）。queue.ts 无 cancel 入口：cancel 迁移边由
//   states.ts transition 提供（running×cancel / queued×cancel → cancelled），farm 调
//   transition + store.writeTask 落盘（running 行 killPane 动作已由 killSync 先行完成）。
//   no-ticker 窗口语义：双扫返回后 shutdown 路径再无扫描/取消动作——此后 spawn 工具
//   新入队的 queued 任务不被 cancel/kill（queued 无 pane 可杀），留盘到下会话
//   session_start 由 Queue.step 正常出队（owner 不变即接续）。
// - GC：挂探测循环顺带执行（≥60s 节流），v2 口径 requests 1h/status 24h/sessions 7d/
//   hb 24h/log 7d。
//
// 依赖纪律：零 pi SDK import——pi/display/notify 全部本文件声明结构性接口（T6 装配时
// 以真实 ExtensionAPI/04 display 实现对接，无需运行时依赖）；运行时 import 仅 node:
// 内置模块与 task-core 相对路径。node 22 type-stripping 约束：禁 enum/namespace/
// 构造器参数属性。

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, rm, stat } from "node:fs/promises";
import { transition } from "./task-core/states.ts";
import type { TaskStatus } from "./task-core/states.ts";
import { buildResumeArgs, findSessionId } from "./task-core/resume.ts";
import type { TaskRecord } from "./task-core/store.ts";
import type { Queue, StepReport } from "./task-core/queue.ts";
import { formatDurationMs } from "./display/format.ts";

// ── 常量（数值 pin：PRD §13.2 / decisions.md / v2 部署版实测口径） ────────────────

/** 通知聚合窗口：距上次 flush ≥2s 发 1 条 followUp */
export const FLUSH_WINDOW_MS = 2000;
/** 补发窗口：updatedAt 距今 ≤24h 的未通知终态任务在 session_start 补发 */
export const REPLAY_WINDOW_MS = 24 * 3600 * 1000;
/** GC 口径（v2 部署版实测）：requests 1h */
export const GC_REQUESTS_TTL_MS = 3600 * 1000;
/** GC 口径：status 信号文件 24h */
export const GC_STATUS_TTL_MS = 24 * 3600 * 1000;
/** GC 口径：sessions 目录 7d（kill 不删 session 文件，回收归 GC） */
export const GC_SESSIONS_TTL_MS = 7 * 24 * 3600 * 1000;
/** GC 口径：心跳 wrapper-*.hb 24h（v2 残留，v3 wrapper 不写 hb） */
export const GC_HB_TTL_MS = 24 * 3600 * 1000;
/** GC 口径：日志 wrapper-*.log 7d（v2 残留） */
export const GC_LOG_TTL_MS = 7 * 24 * 3600 * 1000;
const GC_THROTTLE_MS = 60_000;
const DEFAULT_TICK_MS = 400;
const DEFAULT_PROBE_MS = 3000;

// ── 纯部分（farm.test.ts 单测对象；filterReplay 存活探测默认 process.kill(pid,0)，
//    经可选参数注入以确定性测试） ───────────────────────────────────────────────────

/** 终态集合（timeout 非终态：迁移表 timeout×retry→queued 可复活） */
export type TerminalStatus = "done" | "aborted" | "failed" | "cancelled";

export function isTerminalStatus(status: TaskStatus): status is TerminalStatus {
  return (
    status === "done" || status === "aborted" || status === "failed" || status === "cancelled"
  );
}

/** 通知事件摘要（PRD §13.2：done = taskId+role+status+耗时+exitCode；aborted/cancelled 附恢复命令） */
export interface FarmDoneEvent {
  taskId: string;
  role: string;
  status: TerminalStatus;
  /** 耗时 = updatedAt - startedAt（farm_status 同口径；缺 startedAt 按 0） */
  durationMs: number;
  exitCode: number | null;
  /** 恢复命令行（buildResumeArgs 输出，不含 "pi"）；仅 aborted/cancelled 且 session 可解析时存在 */
  resumeArgs?: string[];
}

/** 单条 followUp 消息（聚合后一次 flush 一条；T6 转 pi.sendMessage） */
export interface FarmDoneMessage {
  events: readonly FarmDoneEvent[];
  /** 预渲染摘要文本（T6 直接作 sendMessage content；摘要不塞全文） */
  text: string;
}

function finiteMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * task record → 通知事件（纯）。终态校验：非终态抛 TypeError。
 * resumeArgs 仅 aborted/cancelled 附带，且需 sessionDir 非空 + sessionId 可解析
 * （kill 不删 session 文件，sessions 目录保留至 GC 7d，恢复数据齐备）。
 */
export function buildDoneEvent(task: TaskRecord, sessionId: string | null): FarmDoneEvent {
  const status = task.status;
  if (!isTerminalStatus(status)) {
    throw new TypeError(`buildDoneEvent: 非终态 status=${JSON.stringify(status)}`);
  }
  const startedAt = finiteMs(task.startedAt);
  const updatedAt = finiteMs(task.updatedAt);
  const spawn = task.payload?.spawn;
  const role = spawn !== undefined && spawn !== null && typeof spawn.role === "string" ? spawn.role : "";
  const exitCode =
    task.result !== undefined && task.result !== null && typeof task.result.exitCode === "number"
      ? task.result.exitCode
      : null;
  const sessionDir =
    task.result !== undefined && task.result !== null && typeof task.result.sessionDir === "string"
      ? task.result.sessionDir
      : "";
  const event: FarmDoneEvent = {
    taskId: task.taskId,
    role,
    status,
    durationMs: Math.max(0, updatedAt - startedAt),
    exitCode,
  };
  if ((status === "aborted" || status === "cancelled") && sessionDir !== "" && sessionId !== null) {
    event.resumeArgs = buildResumeArgs(sessionDir, sessionId);
  }
  return event;
}

const STATUS_LABEL: Record<TerminalStatus, string> = {
  done: "完成",
  aborted: "中止",
  failed: "失败",
  cancelled: "已取消",
};

/** 摘要文本（纯渲染）：<taskId8> <role> <状态> <耗时> [exit=N]；aborted/cancelled 附恢复命令行 */
export function buildDoneText(events: readonly FarmDoneEvent[]): string {
  return events
    .map((event) => {
      const head = `[${event.status}] ${event.taskId.slice(0, 8)} ${event.role || "-"} ${
        STATUS_LABEL[event.status]
      } ${formatDurationMs(event.durationMs)}`;
      const exit = event.exitCode === null ? "" : ` exit=${event.exitCode}`;
      let line = `${head}${exit}`;
      if (event.resumeArgs !== undefined && event.resumeArgs.length >= 5) {
        // buildResumeArgs 形状 pin：["-p","--session-dir",dir,"--session",id]
        line += `\n恢复：pi -p --session-dir "${event.resumeArgs[2]}" --session "${event.resumeArgs[4]}"`;
      }
      return line;
    })
    .join("\n");
}

export interface AggregateResult {
  /** 本次 flush 发出的终态事件（窗口未到或空事件 → []） */
  pending: FarmDoneEvent[];
  /** 新 lastFlushAt：发出时 = now，否则原样返回 */
  nextFlushAt: number;
}

/**
 * 通知聚合器（纯）：终态事件 + 上次 flush 时刻 + now → 待发事件 + 新 lastFlushAt。
 * 语义：距上次 flush ≥ FLUSH_WINDOW_MS（2s）发 1 条（全部缓冲事件一次携带）；
 * 窗口未到 hold（调用方保留缓冲，下个 tick 续投）；空事件原样返回（nextFlushAt 不变）。
 * 防御：同 taskId 重复事件去重（首现为准，防同任务双决策重复通知）。
 * lastFlushAt 缺省/非有限数按 0（初始态：首条事件立即发，无需空等 2s）。
 */
export function aggregateEvents(
  events: readonly FarmDoneEvent[],
  lastFlushAt: number,
  now: number,
): AggregateResult {
  if (!Array.isArray(events)) {
    throw new TypeError("aggregateEvents: events must be an array");
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("aggregateEvents: now must be a finite number (epoch ms)");
  }
  const base = typeof lastFlushAt === "number" && Number.isFinite(lastFlushAt) ? lastFlushAt : 0;
  if (events.length === 0) return { pending: [], nextFlushAt: base };
  const seen = new Set<string>();
  const deduped: FarmDoneEvent[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null || typeof event.taskId !== "string") {
      throw new TypeError("aggregateEvents: 事件必须为 {taskId,...} 形状");
    }
    if (seen.has(event.taskId)) continue;
    seen.add(event.taskId);
    deduped.push(event);
  }
  if (now - base < FLUSH_WINDOW_MS) return { pending: [], nextFlushAt: base };
  return { pending: deduped, nextFlushAt: now };
}

/**
 * owner pid 解析："pid+启动时间"（PRD §13.3 落盘格式）→ pid 部分。
 * 非该格式（缺 owner/旧记录/空串/pid 部分非纯数字）→ null（保守视为活）。
 * 启动时间部分只要求非空（构造格式归 T6；此处只消费 pid）。
 */
export function parseOwnerPid(owner: unknown): number | null {
  if (typeof owner !== "string" || owner === "") return null;
  const sep = owner.indexOf("+");
  if (sep <= 0 || sep === owner.length - 1) return null;
  const pidPart = owner.slice(0, sep);
  if (!/^\d+$/.test(pidPart)) return null;
  const pid = Number(pidPart);
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  return pid;
}

/**
 * 存活探测（默认实现）：process.kill(pid, 0)。
 * ESRCH=死；EPERM=活；其他（EINVAL 等）保守视为活。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code !== "ESRCH";
  }
}

/**
 * owner 进程已死判定（保守）：pid 不可解析或探测非死 → false（视为活，
 * 仅 owner==本进程可补发）。探测可注入（测试确定性）。
 */
export function ownerProcessDead(
  owner: unknown,
  pidAlive: (pid: number) => boolean = isPidAlive,
): boolean {
  const pid = parseOwnerPid(owner);
  return pid !== null && !pidAlive(pid);
}

/**
 * 补发过滤：session_start 补发候选 = 终态 + 未通知（notifiedAt 缺/0/非有限数）
 * + updatedAt 距今 ≤24h + 归属判定——owner==本进程，或 owner 进程已死（跨重启补发：
 * quit 重启后新 pid 不匹配旧任务 owner，旧 owner 进程 kill0=ESRCH 即可补发；owner
 * 进程仍活 → 排除，防双会话重复通知）。返回按 updatedAt 升序（taskId 破序）。
 * 容错：缺 owner / 非 "pid+启动时间" 格式（旧记录）→ 保守视为活，仅 owner==本进程
 * 可补发；缺 updatedAt → 无法证明 24h 内 → 排除；未来 updatedAt → 排除。
 * owner 空串/非字符串 → 空列表。存活探测经 pidAlive 注入（默认 process.kill(pid,0)），
 * 同 pid 每次调用只探测一次。
 * allowDeadOwner（默认 true）：false 时「owner 进程已死」任务一律排除（只补发
 * owner==本进程）——mini-farm 用（depth-1 角色 agent 不接管 main 层死 owner 任务）。
 */
export function filterReplay(
  tasks: readonly TaskRecord[],
  owner: string,
  now: number,
  pidAlive: (pid: number) => boolean = isPidAlive,
  allowDeadOwner: boolean = true,
): TaskRecord[] {
  if (!Array.isArray(tasks)) {
    throw new TypeError("filterReplay: tasks must be an array");
  }
  if (typeof owner !== "string" || owner === "") return [];
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("filterReplay: now must be a finite number (epoch ms)");
  }
  const deadCache = new Map<number, boolean>();
  const isDead = (pid: number): boolean => {
    const cached = deadCache.get(pid);
    if (cached !== undefined) return cached;
    const value = !pidAlive(pid);
    deadCache.set(pid, value);
    return value;
  };
  const due = tasks.filter((task) => {
    if (task === null || typeof task !== "object") return false;
    if (task.owner !== owner) {
      if (!allowDeadOwner) return false;
      const pid = parseOwnerPid(task.owner);
      if (pid === null || !isDead(pid)) return false;
    }
    if (!isTerminalStatus(task.status)) return false;
    const notifiedAt = task.notifiedAt;
    if (typeof notifiedAt === "number" && Number.isFinite(notifiedAt) && notifiedAt > 0) return false;
    const updatedAt = task.updatedAt;
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return false;
    return updatedAt <= now && now - updatedAt <= REPLAY_WINDOW_MS;
  });
  due.sort((a, b) =>
    a.updatedAt !== b.updatedAt
      ? a.updatedAt - b.updatedAt
      : a.taskId < b.taskId
        ? -1
        : a.taskId > b.taskId
          ? 1
          : 0,
  );
  return due;
}

/**
 * pane 差集（纯）：期望 paneId 中实际不存在的（gone）。期望侧去重保序；
 * 空串 paneId 忽略（spawn 未回写 paneId 的任务不可追踪，不误判 gone）。
 */
export function diffPanes(expected: readonly string[], actual: readonly string[]): string[] {
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    throw new TypeError("diffPanes: expected/actual must be arrays");
  }
  const actualSet = new Set<string>();
  for (const id of actual) {
    if (typeof id === "string" && id !== "") actualSet.add(id);
  }
  const gone: string[] = [];
  const seen = new Set<string>();
  for (const id of expected) {
    if (typeof id !== "string" || id === "") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!actualSet.has(id)) gone.push(id);
  }
  return gone;
}

/**
 * 存活判定（纯）：status==running 且 payload.spawn.paneId 非空且 paneId 已消失
 * （不在实际 paneId 集内）→ 返回 taskId 列表（供 Queue.step {paneGone} 注入）。
 * 非 running 任务的 paneId 消失不入选（paneGone 仅对 running 生效，防
 * IllegalTransitionError）。task→paneId 唯一落盘处 = task record。
 */
export function diffGoneRunning(tasks: readonly TaskRecord[], actualPaneIds: readonly string[]): string[] {
  if (!Array.isArray(tasks)) {
    throw new TypeError("diffGoneRunning: tasks must be an array");
  }
  const running: TaskRecord[] = [];
  const expected: string[] = [];
  for (const task of tasks) {
    if (task === null || typeof task !== "object") continue;
    if (task.status !== "running") continue;
    const paneId = task.payload?.spawn?.paneId;
    if (typeof paneId !== "string" || paneId === "") continue;
    running.push(task);
    expected.push(paneId);
  }
  const gone = new Set(diffPanes(expected, actualPaneIds));
  return running.filter((task) => gone.has(task.payload.spawn.paneId)).map((task) => task.taskId);
}

// ── 接口声明（本票最小面；T6 装配时对接 04 display 实现与真实 ExtensionAPI） ──────

/** DisplayClient 最小面（04 实现 wezterm cli 纯原语；一切调用带 --no-auto-start） */
export interface DisplayClient {
  /** split-pane --right → 新 paneId（spawn stdout 即 pane-id，V5 实测稳定唯一）。
   *  签名对齐 04 真实现：cmd 为 argv 数组（wezterm `-- PROG ARGS` 直接 exec，无 shell
   *  解析面）；opts.cwd 映射 --cwd。 */
  spawn(cmd: string[], opts?: { cwd?: string }): Promise<string>;
  /** list --format json 纯解析后的存活 paneId 集（字段缺失容错归 04）。
   *  返回 string[]（paneId 集合）；04 的 PaneInfo[] → string[] 适配由装配层
   *  （index）负责，本接口只消费最终 paneId 集。 */
  listPanes(): Promise<string[]>;
  /** 异步 kill（循环路径 killPane 动作用） */
  kill(paneId: string): Promise<void>;
  /** 同步 kill（session_shutdown 用）：以 spawnSync 实现，防进程退出前异步 kill 未完成 */
  killSync(paneId: string): void;
}

/** notify 出口（T6 接 pi.sendMessage {customType:"farm.done"} followUp + triggerTurn:true） */
export interface FarmNotify {
  (message: FarmDoneMessage): Promise<void>;
}

export interface FarmSessionStartEvent {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export interface FarmSessionShutdownEvent {
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}

/** pi 主机最小面（结构性兼容真实 ExtensionAPI.on 的 session 生命周期重载） */
export interface FarmPi {
  on(
    event: "session_start",
    handler: (event: FarmSessionStartEvent, ctx: unknown) => void | Promise<void>,
  ): void;
  on(
    event: "session_shutdown",
    handler: (event: FarmSessionShutdownEvent, ctx: unknown) => void | Promise<void>,
  ): void;
}

export interface WireFarmOptions {
  queue: Queue;
  display: DisplayClient;
  pi: FarmPi;
  /** 本进程 owner（必须显式传，pin：pid+启动时间；空串/缺失拒绝） */
  owner: string;
  /** 通知出口（T6 接 pi.sendMessage） */
  notify: FarmNotify;
  /** 农场根目录（GC 目标）；默认 ~/.pi-agent-teams */
  farmRoot?: string;
  /** 时钟（epoch ms）；默认 Date.now（测试注入可变时钟） */
  now?: () => number;
  /** ticker 间隔 ms；默认 400 */
  tickIntervalMs?: number;
  /** 探测循环间隔 ms；默认 3000 */
  probeIntervalMs?: number;
  /** shutdown busy 闩排空上限 ms；默认 5000（挂死 step 不拖垮 shutdown） */
  busyDrainTimeoutMs?: number;
  /** GC 开关（默认 true）。mini-farm 传 false——GC 只在 main（防多进程重复 sweep）。 */
  gcEnabled?: boolean;
  /** 补发「owner 进程已死」任务开关（默认 true）。mini-farm 传 false——跨重启补发
   * 只在 main（depth-1 角色 agent 不应补发 main 层死 owner 任务，否则 farm.done
   * 通知的 triggerTurn 会抢在初始 prompt 前触发回合，导致 prompt 丢失）。 */
  replayDeadOwner?: boolean;
}

/** 装配产物：start = session_start 逻辑；stop = session_shutdown 逻辑（均幂等） */
export interface FarmLoop {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ── 装配（session 生命周期归 08 smoke；本部分不单测） ────────────────────────────

interface FarmState {
  tickHandle: ReturnType<typeof setInterval> | null;
  probeHandle: ReturnType<typeof setInterval> | null;
  /** step 串行化闩（ticker 与探测共用；并发 step 同任务双决策 → 重复通知防护） */
  busy: boolean;
  armed: boolean;
  /** stop 幂等闩（与 armed 解耦：start 前/未武装的 stop 也执行清理） */
  done: boolean;
  pendingBuffer: FarmDoneEvent[];
  lastFlushAt: number;
  lastGcAt: number;
}

interface FarmContext {
  cfg: Required<Pick<WireFarmOptions, "queue" | "display" | "owner" | "notify" | "farmRoot" | "now" | "tickIntervalMs" | "probeIntervalMs" | "busyDrainTimeoutMs" | "gcEnabled" | "replayDeadOwner">>;
  state: FarmState;
}

/** 模块级句柄锚点（PRD §13.2：ticker 句柄先清后武装，reload/新会话不残留双 ticker） */
let active: FarmContext | null = null;

function clearActiveHandles(): void {
  if (active === null) return;
  const s = active.state;
  if (s.tickHandle !== null) {
    clearInterval(s.tickHandle);
    s.tickHandle = null;
  }
  if (s.probeHandle !== null) {
    clearInterval(s.probeHandle);
    s.probeHandle = null;
  }
}

/**
 * step 报告 → 终态事件入缓冲（ticker 与探测两条 step 路径共用）。
 * 事件来源单一化：带 notifyMain 动作的终态（aborted/failed）消费 report.notifications
 * （Queue 落点，单一真源，不再从 decisions 重推导）；无 notifyMain 动作的 done
 * （paneDone 迁移行不携带通知）取 decisions。
 */
async function collectTerminalEvents(ctx: FarmContext, report: StepReport): Promise<void> {
  for (const n of report.notifications) {
    const task = await ctx.cfg.queue.store.readTask(n.taskId);
    if (task === null) continue;
    const sessionId = await findSessionId(task.result?.sessionDir ?? "");
    ctx.state.pendingBuffer.push(buildDoneEvent(task, sessionId));
  }
  for (const decision of report.decisions) {
    if (decision.event !== "paneDone") continue;
    const task = await ctx.cfg.queue.store.readTask(decision.taskId);
    if (task === null) continue;
    const sessionId = await findSessionId(task.result?.sessionDir ?? "");
    ctx.state.pendingBuffer.push(buildDoneEvent(task, sessionId));
  }
}

/**
 * 装配 farm 循环（谁武装由调用方（index.ts 按 ownDepth 分派）决定；本函数无条件
 * 装配，main 与 depth-1 mini-farm 均调之，depth-2 不调）。注册 session_start/
 * session_shutdown 钩子并返回 {start, stop}（T8 smoke/调试可手动触发；pi 事件
 * 触发为主路径）。
 */
export function wireFarm(options: WireFarmOptions): FarmLoop {
  validateOptions(options);
  const ctx: FarmContext = {
    cfg: {
      queue: options.queue,
      display: options.display,
      owner: options.owner,
      notify: options.notify,
      farmRoot: options.farmRoot ?? join(homedir(), ".pi-agent-teams"),
      now: options.now ?? (() => Date.now()),
      tickIntervalMs: options.tickIntervalMs ?? DEFAULT_TICK_MS,
      probeIntervalMs: options.probeIntervalMs ?? DEFAULT_PROBE_MS,
      busyDrainTimeoutMs: options.busyDrainTimeoutMs ?? BUSY_DRAIN_TIMEOUT_MS,
      gcEnabled: options.gcEnabled ?? true,
      replayDeadOwner: options.replayDeadOwner ?? true,
    },
    state: {
      tickHandle: null,
      probeHandle: null,
      busy: false,
      armed: false,
      done: false,
      pendingBuffer: [],
      lastFlushAt: 0,
      lastGcAt: 0,
    },
  };
  options.pi.on("session_start", () => start(ctx));
  options.pi.on("session_shutdown", () => stop(ctx));
  return {
    start: () => start(ctx),
    stop: () => stop(ctx),
  };
}

/**
 * session_start 逻辑（幂等）：先清模块级句柄再武装（防旧 pi 引用定时器残留）→
 * 僵尸回收（reapDeadOwnerRunnings）→ 补发（replay）→ 武装 400ms ticker + 3s 探测循环。
 * 回收/补发失败不挡武装（未通知事件留待下次 session_start 再补）。
 */
async function start(ctx: FarmContext): Promise<void> {
  clearActiveHandles();
  active = ctx;
  ctx.state.armed = true;
  ctx.state.done = false;
  ctx.state.pendingBuffer = [];
  ctx.state.lastFlushAt = 0;
  ctx.state.lastGcAt = 0;
  ctx.state.busy = false;
  try {
    await reapDeadOwnerRunnings(ctx); // 僵尸回收先行：aborted + 未通知 → 随后 replay 补发
    await replay(ctx);
  } catch {
    // 回收/补发失败不挡武装
  }
  if (ctx.state.done) return; // 回收/补发期间被 stop：不再武装（防销毁后残留定时器）
  ctx.state.tickHandle = setInterval(() => {
    void stepOnce(ctx);
  }, ctx.cfg.tickIntervalMs);
  ctx.state.probeHandle = setInterval(() => {
    void probeOnce(ctx);
  }, ctx.cfg.probeIntervalMs);
}

/**
 * session_shutdown 逻辑（幂等）：清句柄 → armed=false 挡新 step → 有界等 busy 闩排空
 * （in-flight step 的 spawn 写回 paneId 后双扫才能拿到；上限 busyDrainTimeoutMs
 * 可注入、默认 5s，挂死 step 不拖垮 shutdown）→ spawnSync 同步全 kill 本会话
 * running/timeout pane（killSync；kill 不删 session 文件）→ cancelled 落盘
 * （running + queued；cancel 迁移边由 states.transition 提供，queue.ts 无 cancel
 * 入口，farm 直接 transition+writeTask）。第二遍扫描收口 drain 窗口内的迟到 spawn
 * （防关窗后新 pane 泄漏）。
 *
 * no-ticker 窗口语义（本方法返回后）：armed=false + 句柄已清，shutdown 路径不再有
 * 任何扫描/取消动作——此后 spawn 工具新入队的 queued 任务（quit 前最后一轮用户
 * 输入）不被 cancel/kill（queued 无 pane 可杀），留盘到下会话 session_start 由
 * Queue.step 正常出队（owner 不变即接续）。stop 幂等闩保证窗口内入队不触发二次清理。
 */
async function stop(ctx: FarmContext): Promise<void> {
  if (active === ctx) clearActiveHandles();
  if (ctx.state.done) return; // 幂等：已销毁过直接返回
  ctx.state.done = true;
  ctx.state.armed = false;
  try {
    await awaitBusyDrain(ctx);
    const now = ctx.cfg.now();
    await killAndCancelAll(ctx, now);
    await killAndCancelAll(ctx, now);
  } catch {
    // 销毁路径尽力而为
  }
}

/** busy 闩排空默认上限（真实时钟）：in-flight step 最长等待；超时继续双扫（尽力而为）。
 * 可经 WireFarmOptions.busyDrainTimeoutMs 注入（测试短 drain 验证迟到 spawn 路径）。 */
const BUSY_DRAIN_TIMEOUT_MS = 5000;
const BUSY_DRAIN_POLL_MS = 10;

/**
 * 有界等 in-flight step 排空：armed=false 已挡新 step，只等正在执行的 step 完成——
 * 其 executor.spawn 写回的 paneId 落盘后，双扫才能 killSync（否则关窗后新 pane
 * 泄漏）。用真实时钟（cfg.now 可被测试注入可变时钟，不能作 liveness 依据）；
 * 上限 ctx.cfg.busyDrainTimeoutMs；超时后继续（挂死 step 不拖垮 shutdown）。
 */
async function awaitBusyDrain(ctx: FarmContext): Promise<void> {
  const deadline = Date.now() + ctx.cfg.busyDrainTimeoutMs;
  while (ctx.state.busy && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, BUSY_DRAIN_POLL_MS));
  }
}

/**
 * 本 owner 任务清理（session_shutdown 双扫）：
 * - timeout：pane 可能仍活（wrapper 未退出）→ killSync；状态不动（timeout×cancel
 *   迁移表无此行，下次会话 retry 自然接管）。
 * - running/queued：killSync（仅 running 有 pane）+ cancelled 落盘。
 * 防 stale 快照 clobber：scanTasks 快照可能早于并发 step 的 spawn 写回（drain
 * 超时后 in-flight spawn 仍可把 paneId 落盘）——每任务 readTask 现读最新记录再
 * 决策/落盘；旧快照整记录写回会抹掉并发写回的 paneId（pane 泄漏且探测映射缺失）。
 */
async function killAndCancelAll(ctx: FarmContext, now: number): Promise<void> {
  const own = await ctx.cfg.queue.store.scanTasks(ctx.cfg.owner);
  for (const task of own) {
    // 现读：scan 快照可能早于并发 spawn 写回（stale 快照整记录落盘会 clobber
    // paneId）；readTask 拿最新记录再决策/落盘。现读失败/已删 → 跳过。
    let fresh: TaskRecord | null;
    try {
      fresh = await ctx.cfg.queue.store.readTask(task.taskId);
    } catch {
      continue;
    }
    if (fresh === null) continue;
    if (fresh.status === "timeout") {
      const paneId = fresh.payload?.spawn?.paneId ?? "";
      if (paneId !== "") {
        try {
          ctx.cfg.display.killSync(paneId); // 幂等 kill；状态不动，下次会话 retry
        } catch {
          // kill 失败不挡其余
        }
      }
      continue;
    }
    if (fresh.status !== "running" && fresh.status !== "queued") continue;
    try {
      const result = transition(fresh.status, "cancel"); // running×cancel / queued×cancel → cancelled
      if (fresh.status === "running") {
        const paneId = fresh.payload?.spawn?.paneId ?? "";
        if (paneId !== "") {
          try {
            ctx.cfg.display.killSync(paneId); // spawnSync 同步 kill，不删 session 文件
          } catch {
            // kill 失败不挡 cancelled 落盘
          }
        }
      }
      await ctx.cfg.queue.store.writeTask({ ...fresh, status: result.next, updatedAt: now });
    } catch {
      // 单任务失败不挡其余
    }
  }
}

/**
 * 400ms ticker：Queue.step → 终态决策 → 事件入缓冲 → 聚合 flush。
 * 顶层 try/catch：任何异常（含旧 pi 引用 assertActive）不崩 ticker。
 */
async function stepOnce(ctx: FarmContext): Promise<void> {
  const s = ctx.state;
  if (!s.armed || s.busy) return;
  s.busy = true;
  try {
    const report = await ctx.cfg.queue.step();
    await collectTerminalEvents(ctx, report);
    await flushIfDue(ctx);
  } catch {
    // 顶层 try/catch：不崩 ticker
  } finally {
    s.busy = false;
  }
}

/** 聚合 flush：缓冲非空且窗口 ≥2s → 发 1 条；notify 失败退避 2s（事件保留重试） */
async function flushIfDue(ctx: FarmContext): Promise<void> {
  const s = ctx.state;
  if (s.pendingBuffer.length === 0) return;
  const now = ctx.cfg.now();
  const agg = aggregateEvents(s.pendingBuffer, s.lastFlushAt, now);
  if (agg.pending.length === 0) return;
  try {
    await deliver(ctx, agg.pending);
    s.pendingBuffer = [];
    s.lastFlushAt = agg.nextFlushAt;
  } catch {
    s.lastFlushAt = now; // 通知失败：退避 FLUSH_WINDOW_MS 重试（缓冲保留）
  }
}

/**
 * 通知出口：notify 成功后 notifiedAt 写回。守卫 = owner==本进程 或 owner 进程已死
 * （跨重启补发的死 owner 任务同样写回，防每次重启重复补发；owner 活且非本进程 →
 * 双会话防重，不写回）+ 状态未迁移 + 未通知。
 */
async function deliver(ctx: FarmContext, events: readonly FarmDoneEvent[]): Promise<void> {
  await ctx.cfg.notify({ events, text: buildDoneText(events) });
  const notifiedAt = ctx.cfg.now();
  for (const event of events) {
    try {
      const task = await ctx.cfg.queue.store.readTask(event.taskId);
      if (task === null) continue;
      if (task.owner !== ctx.cfg.owner && !ownerProcessDead(task.owner)) continue;
      if (task.status !== event.status) continue;
      if (typeof task.notifiedAt === "number" && task.notifiedAt > 0) continue;
      await ctx.cfg.queue.store.writeTask({ ...task, notifiedAt });
    } catch {
      // 单任务写回失败不挡其余（未写回的由补发兜底）
    }
  }
}

/**
 * session_start 补发：全量 scanTasks(null)（不做本 owner 预过滤——owner 仲裁（本进程
 * 或 owner 已死）全部交 filterReplay，否则死 owner 任务的跨重启补发分支（US21）
 * 永远不可达）→ filterReplay → 1 条 followUp → notifiedAt 写回。
 */
async function replay(ctx: FarmContext): Promise<void> {
  const all = await ctx.cfg.queue.store.scanTasks(null);
  const due = filterReplay(all, ctx.cfg.owner, ctx.cfg.now(), isPidAlive, ctx.cfg.replayDeadOwner);
  if (due.length === 0) return;
  const events: FarmDoneEvent[] = [];
  for (const task of due) {
    events.push(buildDoneEvent(task, await findSessionId(task.result?.sessionDir ?? "")));
  }
  await deliver(ctx, events);
}

/**
 * session_start 僵尸回收：全量扫描，owner 进程已死的 running 任务（接管崩溃主会话）
 * 先 best-effort killSync 僵尸 pane（按 record.paneId，空跳过；pane 可能早已死，
 * killSync 幂等容忍 no such pane）再以 paneAborted 注入 aborted（与探测 paneGone
 * 同迁移边 running×paneAborted → aborted）。owner 已死 → 无单写者冲突，本进程即
 * 接管写者。释放全局 running 并发位（跨 owner 共享上限）。aborted 为终态 + 未通知
 * → 随后 replay 补发 farm.done（附恢复命令）。存活探测用默认 process.kill(pid,0)
 * （真实 pid 表；owner 不可解析/仍活 → 不动）。
 */
async function reapDeadOwnerRunnings(ctx: FarmContext): Promise<void> {
  const all = await ctx.cfg.queue.store.scanTasks(null);
  const now = ctx.cfg.now();
  for (const task of all) {
    if (task.status !== "running") continue;
    if (task.owner === ctx.cfg.owner) continue;
    if (!ownerProcessDead(task.owner)) continue;
    try {
      const paneId = task.payload?.spawn?.paneId ?? "";
      if (paneId !== "") {
        try {
          ctx.cfg.display.killSync(paneId); // 先杀僵尸 pane（best-effort）再落 aborted
        } catch {
          // kill 失败不挡 aborted 落盘
        }
      }
      const result = transition(task.status, "paneAborted");
      await ctx.cfg.queue.store.writeTask({ ...task, status: result.next, updatedAt: now });
    } catch {
      // 单任务失败不挡其余
    }
  }
}

/**
 * 3s 探测循环：GC tick（≥60s 节流）顺带执行；pane 存活探测仅存在 running 任务时
 * 执行（list 单次 ~1.2s，无任务不白烧 cli 调用）——差集经 Queue.step {paneGone}
 * 注入 aborted。探测失败（L1/L2/cli 错误）不崩循环。
 */
async function probeOnce(ctx: FarmContext): Promise<void> {
  const s = ctx.state;
  if (!s.armed) return;
  try {
    await gcIfDue(ctx);
    const own = await ctx.cfg.queue.store.scanTasks(ctx.cfg.owner);
    if (!own.some((task) => task.status === "running")) return;
    const actual = await ctx.cfg.display.listPanes();
    const gone = diffGoneRunning(own, actual);
    if (gone.length === 0) return;
    if (s.busy) return; // 与 ticker 串行化；本轮差集下一探测周期重检
    s.busy = true;
    try {
      const report = await ctx.cfg.queue.step({ paneGone: gone });
      await collectTerminalEvents(ctx, report); // aborted 通知与 ticker 同一条聚合路径
      await flushIfDue(ctx);
    } finally {
      s.busy = false;
    }
  } catch {
    // 探测失败不崩循环
  }
}

async function gcIfDue(ctx: FarmContext): Promise<void> {
  if (!ctx.cfg.gcEnabled) return;
  const s = ctx.state;
  const now = ctx.cfg.now();
  if (s.lastGcAt !== 0 && now - s.lastGcAt < GC_THROTTLE_MS) return;
  s.lastGcAt = now;
  await gcOnce(ctx.cfg.farmRoot, now);
}

/**
 * GC（v2 口径，挂探测循环顺带执行）：requests 1h / status 24h / sessions 7d /
 * inbox 24h（逐文件级）/ usage 24h / presence 24h / wrapper-*.hb 24h /
 * wrapper-*.log 7d。全 best-effort（目录缺失/单文件失败跳过）。
 * 注意 tasks/ 不在 GC 清单（farm_status/补发数据源，口径调整另议）。
 */
export async function gcOnce(root: string, now: number): Promise<void> {
  await sweepDir(join(root, "requests"), now, GC_REQUESTS_TTL_MS, (name) => /\.agent-prompt$/.test(name), false);
  await sweepDir(join(root, "status"), now, GC_STATUS_TTL_MS, (name) => /\.(done|aborted)$/.test(name), false);
  await sweepDir(join(root, "sessions"), now, GC_SESSIONS_TTL_MS, () => true, true);
  await sweepInbox(join(root, "inbox"), now);
  // usage/presence 均含原子写 .tmp（wrapper tmp+mv / presence tmp+rename）——rename 前崩溃
  // 即残留，故 matcher 需一并回收 .tmp，防无限堆积。
  await sweepDir(join(root, "usage"), now, GC_STATUS_TTL_MS, (name) => /\.(json|tmp)$/.test(name), false);
  await sweepDir(join(root, "presence"), now, GC_STATUS_TTL_MS, (name) => /\.(json|tmp)$/.test(name), false);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const isHb = name.startsWith("wrapper-") && name.endsWith(".hb");
    const isLog = name.startsWith("wrapper-") && name.endsWith(".log");
    if (!isHb && !isLog) continue;
    const ttlMs = isHb ? GC_HB_TTL_MS : GC_LOG_TTL_MS;
    try {
      const path = join(root, name);
      const st = await stat(path);
      if (st.isFile() && now - st.mtimeMs > ttlMs) await rm(path, { force: true });
    } catch {
      // 单文件失败跳过
    }
  }
}

async function sweepDir(
  dir: string,
  now: number,
  ttlMs: number,
  match: (name: string) => boolean,
  recursive: boolean,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return; // 目录不存在 → 跳过
  }
  for (const name of names) {
    if (!match(name)) continue;
    try {
      const path = join(dir, name);
      const st = await stat(path);
      if (now - st.mtimeMs > ttlMs) await rm(path, { recursive, force: true });
    } catch {
      // 单文件失败跳过
    }
  }
}

/** inbox 逐文件级 sweep（PR#2）：inbox/<paneId>/<msgId>.json 按 24h 口径——
 *  逐文件删除，不整删 pane 目录（目录内 fresh 消息须保留）。 */
async function sweepInbox(inboxDir: string, now: number): Promise<void> {
  let panes: string[];
  try {
    panes = await readdir(inboxDir);
  } catch {
    return; // inbox 目录不存在 → 跳过
  }
  for (const pane of panes) {
    const dir = join(inboxDir, pane);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue; // 非目录（防御）→ 跳过
    }
    for (const name of names) {
      try {
        const path = join(dir, name);
        const st = await stat(path);
        if (st.isFile() && now - st.mtimeMs > GC_STATUS_TTL_MS) await rm(path, { force: true });
      } catch {
        // 单文件失败跳过
      }
    }
  }
}

function validateOptions(options: WireFarmOptions): void {
  if (options === null || typeof options !== "object") {
    throw new TypeError("wireFarm: options must be an object");
  }
  const { queue, display, pi, owner, notify } = options;
  if (
    queue === null ||
    typeof queue !== "object" ||
    typeof queue.step !== "function" ||
    queue.store === null ||
    typeof queue.store !== "object" ||
    typeof queue.store.scanTasks !== "function" ||
    typeof queue.store.readTask !== "function" ||
    typeof queue.store.writeTask !== "function"
  ) {
    throw new TypeError("wireFarm: queue must be a Queue（store.scanTasks/readTask/writeTask + step）");
  }
  if (
    display === null ||
    typeof display !== "object" ||
    typeof display.spawn !== "function" ||
    typeof display.listPanes !== "function" ||
    typeof display.kill !== "function" ||
    typeof display.killSync !== "function"
  ) {
    throw new TypeError("wireFarm: display must implement DisplayClient（spawn/listPanes/kill/killSync）");
  }
  if (pi === null || typeof pi !== "object" || typeof pi.on !== "function") {
    throw new TypeError("wireFarm: pi must implement FarmPi（session_start/session_shutdown on 重载）");
  }
  if (typeof owner !== "string" || owner === "") {
    throw new TypeError("wireFarm: owner must be a non-empty string（显式传本进程 owner，pin）");
  }
  if (typeof notify !== "function") {
    throw new TypeError("wireFarm: notify must be a function");
  }
  if (options.farmRoot !== undefined && (typeof options.farmRoot !== "string" || options.farmRoot === "")) {
    throw new TypeError("wireFarm: farmRoot must be a non-empty string");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("wireFarm: now must be a function returning epoch ms");
  }
  if (
    options.tickIntervalMs !== undefined &&
    (!Number.isInteger(options.tickIntervalMs) || options.tickIntervalMs < 1)
  ) {
    throw new TypeError("wireFarm: tickIntervalMs must be an integer >= 1");
  }
  if (
    options.probeIntervalMs !== undefined &&
    (!Number.isInteger(options.probeIntervalMs) || options.probeIntervalMs < 1)
  ) {
    throw new TypeError("wireFarm: probeIntervalMs must be an integer >= 1");
  }
  if (
    options.busyDrainTimeoutMs !== undefined &&
    (!Number.isInteger(options.busyDrainTimeoutMs) || options.busyDrainTimeoutMs < 1)
  ) {
    throw new TypeError("wireFarm: busyDrainTimeoutMs must be an integer >= 1");
  }
  if (options.gcEnabled !== undefined && typeof options.gcEnabled !== "boolean") {
    throw new TypeError("wireFarm: gcEnabled must be a boolean");
  }
  if (options.replayDeadOwner !== undefined && typeof options.replayDeadOwner !== "boolean") {
    throw new TypeError("wireFarm: replayDeadOwner must be a boolean");
  }
}
