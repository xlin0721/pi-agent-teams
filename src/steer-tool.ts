// src/steer-tool.ts
// steer 工具纯逻辑层（票 03）：可被 node --test 直接 import（零 pi SDK 依赖）。
// 依据：.scratch/m3-command/plans/03-plan.md（lead 已批准，决策点 1 采用备选：
// 纯逻辑层从 render-mini.ts 移到本文件，与 probe.ts 先例一致）。
//
// A：main 侧 steer 工具执行——executeSteer / steerAckText / steerRejectText
//    （依赖注入 readTask/deliver，纯可测）。
// B：TUI sink 映射 + 渲染行 + paneId 启动轮询——buildSteerMessageArgs /
//    buildSteerSink / steerBubbleLines / formatClockTime / resolveOwnPaneId
//    （票 05 直接 import 装配）。
// C（B 形态读侧 buildInboxSink / resolvePaneId / SpawnFields.paneId / 400ms 轮询）
//    归 display/render-mini.ts（票 03 独占装配，复用本文件 formatClockTime）。
// 零第三方 import：仅相对 .ts import（wrapText 自 display/primitives.ts）。

import type { PollSink } from "./comm/inbox.ts";
import { listAlive, resolveRole } from "./comm/presence.ts";
import type { Presence } from "./comm/presence.ts";
import type { DeliverInput, InboxMessage } from "./task-core/steer.ts";
import type { TaskRecord } from "./task-core/store.ts";
import { transition } from "./task-core/states.ts";
import type { TaskStatus } from "./task-core/states.ts";
import { queuedPosition } from "./probe.ts";
import { stripAnsiText, wrapText } from "./display/primitives.ts";

// ── A：main 侧 steer 工具纯逻辑 ─────────────────────────────────────────────

export interface SteerToolParams {
  targetTaskId: string;
  content: string;
}

export interface SteerToolDeps {
  readTask: (taskId: string) => Promise<TaskRecord | null>;
  deliver: (input: DeliverInput) => Promise<InboxMessage>;
}

/** ✅ 已向 <taskId 前 8 位> 发送 steer（其当前工具跑完后生效） */
export function steerAckText(taskId: string): string {
  return `✅ 已向 ${taskId.slice(0, 8)} 发送 steer（其当前工具跑完后生效）`;
}

/** 终态中文标签（与 probe.ts FARM_STATUS_LABELS 终态口径一致；本地内联避免跨层 import） */
const TERMINAL_LABELS: Record<string, string> = {
  done: "完成",
  aborted: "中止",
  failed: "失败",
  cancelled: "已取消",
};

/**
 * 拒绝文案：null=未找到 / queued / timeout / 终态(done|aborted|failed|cancelled)
 * 分型，恒含 farm_status 引导（票面验收锚点）。
 */
export function steerRejectText(status: TaskStatus | null, taskId: string): string {
  if (status === null) {
    return `❌ 未找到任务 ${taskId}。可用 farm_status（无参数）查看全列表。`;
  }
  if (status === "queued") {
    return `❌ 目标任务 ${taskId} 仍在排队（queued），尚未运行，steer 无效。可用 farm_status ${taskId} 查看排队进度。`;
  }
  if (status === "timeout") {
    return `❌ 目标任务 ${taskId} 处于超时重试中（timeout），未在运行，steer 无效。可用 farm_status ${taskId} 查看。`;
  }
  const label = TERMINAL_LABELS[status] ?? status;
  return `❌ 目标任务 ${taskId} 已结束（${label}），steer 无效。可用 farm_status ${taskId} 查看结果。`;
}

/**
 * 执行：readTask → status==running 校验 → paneId 提取 → deliver → ack。
 * deps 注入（readTask/deliver 为外部 I/O），纯逻辑可测。
 * 返回 pi 工具结果形状 { content: [{type:"text", text}] }。
 */
export async function executeSteer(
  params: SteerToolParams,
  deps: SteerToolDeps,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const record = await deps.readTask(params.targetTaskId);
  if (record === null) {
    return { content: [{ type: "text", text: steerRejectText(null, params.targetTaskId) }] };
  }
  if (record.status !== "running") {
    return { content: [{ type: "text", text: steerRejectText(record.status, params.targetTaskId) }] };
  }
  const paneId = record.payload?.spawn?.paneId;
  if (typeof paneId !== "string" || paneId === "") {
    return {
      content: [
        {
          type: "text",
          text:
            `⚠ 目标任务 ${params.targetTaskId} 的 pane 尚未就绪（spawn 未写回 paneId），steer 未发送。` +
            `请稍后重试，或用 farm_status ${params.targetTaskId} 查看状态。`,
        },
      ],
    };
  }
  await deps.deliver({
    type: "steer",
    from: "main",
    to: paneId,
    delivery: "directive",
    content: params.content,
  });
  return { content: [{ type: "text", text: steerAckText(params.targetTaskId) }] };
}

// ── B：TUI sink 映射（票 05 直接 import 装配） ───────────────────────────────

export interface SendMessageLike {
  sendMessage: (message: unknown, options?: unknown) => void;
}

/** steer 消息 → sendMessage 两参形状（BE#7 断言锚点） */
export function buildSteerMessageArgs(msg: InboxMessage): {
  message: {
    customType: "farm.steer";
    content: string;
    display: true;
    details: { from: string; ts: number };
  };
  options: { deliverAs: "steer"; triggerTurn: true };
} {
  return {
    message: {
      customType: "farm.steer",
      content: msg.content,
      display: true,
      details: { from: stripAnsiText(msg.from), ts: msg.ts },
    },
    options: { deliverAs: "steer", triggerTurn: true },
  };
}

/** TUI sink：steer/msg 各自映射 sendMessage（票 04 追加 msg 分支）；
 *  advance/at-most-once 由 pollInbox 内置 */
export function buildSteerSink(pi: SendMessageLike): PollSink {
  return (msg) => {
    if (msg.type === "steer") {
      const { message, options } = buildSteerMessageArgs(msg);
      pi.sendMessage(message, options);
      return;
    }
    if (msg.type === "msg") {
      const { message, options } = buildMsgMessageArgs(msg);
      pi.sendMessage(message, options);
      return;
    }
  };
}

// ── 票 04：msg 工具纯逻辑（A：寻址 + fan-out；B：TUI sink 映射）──────────────

export interface MsgToolParams {
  targets: string[];
  delivery: "notice" | "directive";
  content: string;
}

export interface MsgToolDeps {
  readPresences: () => Promise<readonly Presence[]>;
  scanTasks: (owner: string | null) => Promise<TaskRecord[]>;
  deliver: (input: DeliverInput) => Promise<InboxMessage>;
  from: string;
  now?: () => number;
}

/** ✅ 已向 N 个 agent 发送 <delivery>（notice 只显示 / directive 触发行动） */
export function msgAckText(count: number, delivery: "notice" | "directive"): string {
  return `✅ 已向 ${count} 个 agent 发送 ${delivery}（notice 只显示 / directive 触发行动）`;
}

/** ⚠ 部分失败：已向 <sent> 个 agent 发送 <delivery>，其中 <failed> 条失败
 *  （fan-out 逐条 try/catch 后仍给出可观测反馈，不因单条 deliver 抛错中断工具）。 */
export function msgPartialAckText(
  sent: number,
  failed: number,
  delivery: "notice" | "directive",
): string {
  return `⚠ 已向 ${sent} 个 agent 发送 ${delivery}，其中 ${failed} 条失败（notice 只显示 / directive 触发行动）`;
}

/** 0 命中明示（边缘语义 P8①） */
export function msgNoReceiverText(): string {
  return "⚠ 无在运行的接收者：targets 未命中任何存活 pane 或 running 任务。可用 farm_status（无参数）查看全列表。";
}

/** 寻址过滤选项（C9）：excludeDepthGE 设置时排除 depth≥n 的实例（会议广播传 2）。 */
export interface ResolveMsgOpts {
  /** 排除 depth ≥ 该值的实例；缺省/undefined = 不过滤（FR5『all 含 depth-2 worker 收信』契约不变） */
  excludeDepthGE?: number;
}

/**
 * 寻址裁决③（纯）：targets 逐项 → paneId[]（去重保序）。
 *   "all" → presence.listAlive() 全部 paneId；presence 空 → 回退 running 记录 paneId；
 *   role  → presence.resolveRole(role)（同名多实例 fan-out）；presence 缺失
 *           → 回退 running 记录 payload.spawn.role 匹配；
 *   空 paneId 一律跳过。
 * opts.excludeDepthGE：presence 与 running 双路径先滤 depth≥n（depth 缺失/非数保守放行，
 * 存量记录不误伤）；缺省无过滤。
 */
export function resolveMsgTargets(
  targets: readonly string[],
  presences: readonly Presence[],
  runningTasks: readonly TaskRecord[],
  now: number,
  opts?: ResolveMsgOpts,
): string[] {
  const excludeGE = opts?.excludeDepthGE;
  const depthOk = (depth: unknown): boolean =>
    excludeGE === undefined ||
    typeof depth !== "number" ||
    !Number.isFinite(depth) ||
    depth < excludeGE;
  const pres =
    excludeGE === undefined ? presences : presences.filter((p) => depthOk(p.depth));
  const running =
    excludeGE === undefined ? runningTasks : runningTasks.filter((t) => depthOk(t.depth));
  const out: string[] = [];
  const push = (paneId: string): void => {
    if (typeof paneId === "string" && paneId !== "" && !out.includes(paneId)) out.push(paneId);
  };
  const alivePaneIds = (): string[] => listAlive(pres, now).map((p) => p.paneId);

  for (const raw of targets) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const target = raw.trim();
    if (target === "all") {
      const alive = alivePaneIds();
      if (alive.length > 0) {
        for (const paneId of alive) push(paneId);
      } else {
        // presence 空 → 回退 running 记录 paneId
        for (const t of running) {
          const paneId = t.payload?.spawn?.paneId;
          if (typeof paneId === "string") push(paneId);
        }
      }
      continue;
    }
    if (target === "main") {
      push("main");
      continue;
    }
    const matched = resolveRole(pres, target, now);
    if (matched.length > 0) {
      for (const paneId of matched) push(paneId);
    } else {
      // presence 缺失 → 回退 running 记录 payload.spawn.role 匹配
      for (const t of running) {
        if (t.payload?.spawn?.role === target) {
          const paneId = t.payload?.spawn?.paneId;
          if (typeof paneId === "string") push(paneId);
        }
      }
    }
  }
  return out;
}

/**
 * 会议邀请集裁决（C1/C12 + C9 收敛）：resolveMsgTargets 同形 + excludeDepthGE:2
 * （presence.depth + running task.depth 双路径）——depth-2 worker 无 msg 工具、不回
 * main，拉进会议恒 120s 弃权。C9 起改为纯透传 opts 的单函数实现（不再复制 depth
 * 过滤逻辑），与 executeMsg 投递共用同一寻址——编排邀请集 == 实际投递集（结构性）。
 * depth 缺省/非数 → 保守放行（存量记录不误伤）。presence.depth 死字段在此被启用（C12）。
 */
export function resolveMeetingTargets(
  targets: readonly string[],
  presences: readonly Presence[],
  runningTasks: readonly TaskRecord[],
  now: number,
): string[] {
  return resolveMsgTargets(targets, presences, runningTasks, now, { excludeDepthGE: 2 });
}

/**
 * from 身份（纯）：ownTaskId=="" → "main"；否则 presence 反查 taskId 命中 → paneId；
 * 兜底 readTask paneId → 仍空则 ownTaskId（paneId 未写回时的可读身份）。
 */
export function resolveMsgFrom(
  ownTaskId: string,
  presences: readonly Presence[],
  record: TaskRecord | null,
): string {
  if (typeof ownTaskId !== "string" || ownTaskId === "") return "main";
  for (const p of presences) {
    if (p.taskId === ownTaskId && typeof p.paneId === "string" && p.paneId !== "") {
      return p.paneId;
    }
  }
  const paneId = record?.payload?.spawn?.paneId;
  if (typeof paneId === "string" && paneId !== "") return paneId;
  return ownTaskId;
}

/** 执行选项（C9）：寻址过滤 + 读侧 depthCap 兜底标记。 */
export interface ExecuteMsgOpts {
  /** 寻址过滤：排除 depth ≥ n（会议广播传 2；缺省不过滤） */
  excludeDepthGE?: number;
  /** 投递消息 depthCap（读侧兜底：ownDepth ≥ depthCap 跳过；缺省不写该字段） */
  depthCap?: number;
}

/** 执行：寻址 → 0 命中明示 / fan-out N 条 deliver（逐条 try/catch，部分失败给
 *  可观测反馈）→ ack。opts.excludeDepthGE 时编排与投递共用同一过滤寻址
 *  （编排邀请集 == 实际投递集）；opts.depthCap 随消息落盘供读侧兜底。 */
export async function executeMsg(
  params: MsgToolParams,
  deps: MsgToolDeps,
  opts?: ExecuteMsgOpts,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const now = deps.now?.() ?? Date.now();
  const presences = await deps.readPresences();
  const all = await deps.scanTasks(null);
  const running = all.filter((t) => t.status === "running");
  const targets = resolveMsgTargets(params.targets ?? [], presences, running, now, opts);
  if (targets.length === 0) {
    return { content: [{ type: "text", text: msgNoReceiverText() }] };
  }
  let failed = 0;
  for (const paneId of targets) {
    try {
      await deps.deliver({
        type: "msg",
        from: deps.from,
        to: paneId,
        delivery: params.delivery,
        content: params.content,
        ...(typeof opts?.depthCap === "number" ? { depthCap: opts.depthCap } : {}),
      });
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) {
    return {
      content: [
        {
          type: "text",
          text: msgPartialAckText(targets.length - failed, failed, params.delivery),
        },
      ],
    };
  }
  return { content: [{ type: "text", text: msgAckText(targets.length, params.delivery) }] };
}

/** msg → sendMessage 两参形状（notice=followUp / directive=steer+triggerTurn，BE#7 同款锚点） */
export function buildMsgMessageArgs(msg: InboxMessage): {
  message: {
    customType: "farm.msg.notice" | "farm.msg.directive";
    content: string;
    display: true;
    details: { from: string; ts: number };
  };
  options: { deliverAs: "followUp" } | { deliverAs: "steer"; triggerTurn: true };
} {
  const customType = msg.delivery === "directive" ? "farm.msg.directive" : "farm.msg.notice";
  return {
    message: {
      customType,
      content: msg.content,
      display: true,
      details: { from: stripAnsiText(msg.from), ts: msg.ts },
    },
    options:
      msg.delivery === "directive"
        ? { deliverAs: "steer", triggerTurn: true }
        : { deliverAs: "followUp" },
  };
}

// ── 票 08：resume 工具纯逻辑（main-only，复用 aborted×resume 迁移边）─────────

export interface ResumeToolParams {
  taskId: string;
}

export interface ResumeToolDeps {
  readTask: (taskId: string) => Promise<TaskRecord | null>;
  scanTasks: (owner: string | null) => Promise<TaskRecord[]>;
  writeTask: (record: TaskRecord) => Promise<void>;
  findSessionId: (sessionDir: string) => Promise<string | null>;
  owner: string;
  now?: () => number;
}

/** ✅ 已恢复任务 <taskId8>，将从上次对话继续（排队位置 N / 队列有空位，即将开始）。
 *  position=0（writeTask 后同 tick 被出队的竞态）→ 对齐 spawnAckText 的「即将开始」分支。 */
export function resumeAckText(taskId: string, position: number): string {
  const queuePart = position > 0 ? `排队位置 ${position}` : "队列有空位，即将开始";
  return `✅ 已恢复任务 ${taskId.slice(0, 8)}，将从上次对话继续（${queuePart}）`;
}

/** 拒绝分型文案：not-found / cross-owner / not-aborted（仅 aborted 支持 resume）/
 *  session-gone（会话已被回收，无法恢复） */
export function resumeRejectText(
  reason: "not-found" | "cross-owner" | "not-aborted" | "session-gone",
  taskId: string,
  status?: TaskStatus | null,
): string {
  switch (reason) {
    case "not-found":
      return `❌ 未找到任务 ${taskId}。可用 farm_status（无参数）查看全列表。`;
    case "cross-owner":
      return `❌ 任务 ${taskId} 不属于本进程 owner，无法恢复（跨 owner resume 未支持）。`;
    case "not-aborted":
      return `❌ 任务 ${taskId} 当前状态为 ${status ?? "非 aborted"}，仅 aborted 任务支持 resume，failed/cancelled 请重新派发。`;
    case "session-gone":
      return `❌ 任务 ${taskId} 的会话已被回收，无法恢复（会话保留 3 天，超期后 GC）。`;
  }
}

/**
 * 执行（main-only）：
 *   1) readTask → null → not-found；
 *   2) owner 校验（record.owner !== deps.owner → cross-owner，含 depth-2 任务 → M4+）；
 *   3) status !== "aborted" → not-aborted（PR#1：failed/cancelled 一并拒绝）；
 *   4) findSessionId(result.sessionDir) → null → session-gone（任务留原态 aborted）；
 *   5) 复用迁移边 aborted×resume→queued：transition("aborted","resume") →
 *      fill payload.spawn.resumeFrom=sessionId → writeTask（owner 不变，updatedAt=now）；
 *   6) scanTasks(null) + queuedPosition → ack。
 */
export async function executeResume(
  params: ResumeToolParams,
  deps: ResumeToolDeps,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const record = await deps.readTask(params.taskId);
  if (record === null) {
    return { content: [{ type: "text", text: resumeRejectText("not-found", params.taskId) }] };
  }
  if (record.owner !== deps.owner) {
    return { content: [{ type: "text", text: resumeRejectText("cross-owner", params.taskId) }] };
  }
  if (record.status !== "aborted") {
    return {
      content: [
        { type: "text", text: resumeRejectText("not-aborted", params.taskId, record.status) },
      ],
    };
  }
  const sessionId = await deps.findSessionId(record.result?.sessionDir ?? "");
  if (sessionId === null || sessionId === "") {
    return { content: [{ type: "text", text: resumeRejectText("session-gone", params.taskId) }] };
  }
  const now = deps.now?.() ?? Date.now();
  const res = transition("aborted", "resume");
  const next: TaskRecord = {
    ...record,
    status: res.next,
    updatedAt: now,
    payload: {
      ...record.payload,
      spawn: { ...record.payload.spawn, resumeFrom: sessionId },
    },
  };
  await deps.writeTask(next);
  const tasks = await deps.scanTasks(null);
  const position = queuedPosition(tasks, record.taskId);
  return { content: [{ type: "text", text: resumeAckText(record.taskId, position) }] };
}

// ── 渲染行（TUI 气泡 / B 侧系统行共用标签） ─────────────────────────────────

/** epoch ms → "HH:MM:SS"（本地时区，两位补零） */
export function formatClockTime(tsMs: number): string {
  const d = new Date(tsMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface SteerBubbleInput {
  content: string;
  details?: { from?: string; ts?: number };
}

/**
 * 首行 = "📨 来自 <from> · <HH:MM:SS>"，正文 wrapText(content, width-2)。
 * 结构型 renderer 复用（评审整改 BE#7/决策点 3：零 pi-tui import，自折行防超宽撕裂）。
 */
export function steerBubbleLines(message: SteerBubbleInput, width: number): string[] {
  const from =
    typeof message.details?.from === "string" && message.details.from !== ""
      ? stripAnsiText(message.details.from)
      : "unknown";
  const ts =
    typeof message.details?.ts === "number" && Number.isFinite(message.details.ts)
      ? formatClockTime(message.details.ts)
      : formatClockTime(Date.now());
  const content = typeof message.content === "string" ? stripAnsiText(message.content) : "";
  const header = `📨 来自 ${from} · ${ts}`;
  const bodyWidth = width - 2;
  const body =
    content === "" ? [] : bodyWidth > 0 ? wrapText(content, bodyWidth) : [content];
  return [header, ...body];
}

// ── paneId 启动轮询（TUI 与 B 侧共用语义） ───────────────────────────────────

export interface ResolvePaneIdOptions {
  /** 时钟注入（deadline 计算用；测试注入固定时钟时勿配非零 timeoutMs 防空转） */
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
  /** 早退信号（票 TD2）：aborted 即返回 ""，与超时同值不区分 */
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/**
 * TUI 侧：readTask 注入轮询到 payload.spawn.paneId 非空；超时返回 ""。
 * 轮询不阻塞（setTimeout 异步）；paneId 由派发方 Queue 在 spawn 后写回。
 */
export async function resolveOwnPaneId(
  readTask: (taskId: string) => Promise<TaskRecord | null>,
  taskId: string,
  opts: ResolvePaneIdOptions = {},
): Promise<string> {
  const nowFn = opts.now ?? Date.now;
  const pollMs = typeof opts.pollMs === "number" && opts.pollMs > 0 ? opts.pollMs : 200;
  const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
  const deadline = nowFn() + timeoutMs;
  for (;;) {
    if (opts.signal?.aborted) return "";
    const record = await readTask(taskId);
    const paneId = record?.payload?.spawn?.paneId;
    if (typeof paneId === "string" && paneId !== "") return paneId;
    if (nowFn() >= deadline) return "";
    await sleep(pollMs);
  }
}
