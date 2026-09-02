// src/probe.ts
// 本票零依赖纯逻辑层（06 装配票）：capability probe（PRD §13.6 A）+ FR9 降级门
// （§13.6 B）+ spawn 角色枚举校验（US9/US10）+ farm_status 渲染（US3/US4）+
// 排队位置/ack 文案（US1/US13）。零 pi SDK import——pi SDK 装配全部归 index.ts
// （运行时边界，唯一可 import pi SDK 的模块）；本模块只 import node 内置与
// display/farm/task-core 零依赖相对路径。
//
// 测试接缝：全部函数纯或依赖注入（env/list/readDirNames/now 均可注入），
// probe.test.ts + index.test.ts 以 node:test 覆盖。
// node 22 type-stripping 约束：禁 enum/namespace/构造器参数属性（本文件均未使用）。

import { classifyCliFailure } from "./display/protocol.ts";
import { CliError } from "./display/split.ts";
import { formatDurationMs } from "./display/format.ts";
import { buildResumeArgs } from "./task-core/resume.ts";
import { splitTasksForDisplay } from "./task-core/cleanup.ts";
import type { TaskStatus } from "./task-core/states.ts";
import type { TaskRecord } from "./task-core/store.ts";
import type { UsageSidecar } from "./task-core/queue.ts";

// ── §1 capability probe（PRD §13.6 A：五项，启动执行写 config.json） ─────────

export interface ProbeCapabilities {
  /** pane 内扩展可加载 + PI_AGENT_TEAMS_PANE=1 契约可读（wrapper 保证值；主会话未设也算通过） */
  paneMarker: boolean;
  /** sendMessage steer/followUp 出口存在（真实投递行为归 08 smoke 验证） */
  steer: boolean;
  /** getActiveTools 读回 + setActiveTools no-op 写回不抛（真实行为验证，不改激活集） */
  setActiveTools: boolean;
  /** --session-dir 恢复（wrapper 恒用该 flag，恒 true，不再探测——M3 票 01） */
  resume: boolean;
  /** --append-system-prompt 人设注入（wrapper 有人设时用该 flag，恒 true，不再探测） */
  appendSystemPrompt: boolean;
}

export interface ProbeResult {
  capabilities: ProbeCapabilities;
  piVersion: string;
  probedAt: number;
}

export const PROBE_CAPABILITY_KEYS = [
  "paneMarker",
  "steer",
  "setActiveTools",
  "resume",
  "appendSystemPrompt",
] as const;

/**
 * probe 结果形状解析（纯，测试目标）：capabilities 五项必须全为 boolean、
 * piVersion 必须为非空 string、probedAt 必须为有限 number（epoch ms）。
 * 多余字段容忍（config.json 携带 piBin/piScript 等扩展字段，读侧不拒）。
 * 形状非法 → null（不抛）。
 */
export function parseProbeResult(raw: unknown): ProbeResult | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const capsRaw = obj["capabilities"];
  if (capsRaw === null || typeof capsRaw !== "object" || Array.isArray(capsRaw)) return null;
  const caps: ProbeCapabilities = {
    paneMarker: false,
    steer: false,
    setActiveTools: false,
    resume: false,
    appendSystemPrompt: false,
  };
  for (const key of PROBE_CAPABILITY_KEYS) {
    const value = (capsRaw as Record<string, unknown>)[key];
    if (typeof value !== "boolean") return null;
    caps[key] = value;
  }
  const piVersion = obj["piVersion"];
  const probedAt = obj["probedAt"];
  if (typeof piVersion !== "string" || piVersion === "") return null;
  if (typeof probedAt !== "number" || !Number.isFinite(probedAt)) return null;
  return { capabilities: caps, piVersion, probedAt };
}

export interface ProbeDeps {
  /** pi API 表面（index.ts 传真实 ExtensionAPI 闭包；测试传 fake） */
  pi: {
    sendMessage?: unknown;
    getActiveTools?: () => unknown;
    setActiveTools?: (names: readonly unknown[]) => void;
  };
  env: Record<string, string | undefined>;
  /** 时钟（epoch ms） */
  now: () => number;
  /** pi 版本（pi SDK VERSION） */
  version: string;
}

/**
 * 启动探测（§13.6 A 五项）：可探测项（paneMarker/steer/setActiveTools）单项失败=false、
 * 绝不整体抛错（探测失败不阻断扩展加载）。resume/appendSystemPrompt 为常量 true
 * （非探测）：wrapper.sh 直接使用 --session-dir（恒用）/ --append-system-prompt
 * （有人设时用），不探测其支持性——若 CLI 不支持，spawn 早已失败；原 `pi --help`
 * 判定会加载扩展→递归→拖垮 CPU，M3 票 01 根因，已删除进程探测。
 */
export async function runProbe(deps: ProbeDeps): Promise<ProbeResult> {
  const caps: ProbeCapabilities = {
    paneMarker: false,
    steer: false,
    setActiveTools: false,
    resume: false,
    appendSystemPrompt: false,
  };
  try {
    const pane = deps.env["PI_AGENT_TEAMS_PANE"];
    caps.paneMarker = pane === undefined || pane === "1";
  } catch {
    // 单项失败不阻断
  }
  try {
    caps.steer = typeof deps.pi.sendMessage === "function";
  } catch {
    // 单项失败不阻断
  }
  try {
    if (typeof deps.pi.getActiveTools === "function" && typeof deps.pi.setActiveTools === "function") {
      const active = deps.pi.getActiveTools();
      if (Array.isArray(active) && active.every((name) => typeof name === "string")) {
        deps.pi.setActiveTools(active);
        caps.setActiveTools = true;
      }
    }
  } catch {
    // 单项失败不阻断
  }
  // 常量 true（理由见函数 doc；M3 票 01：删 pi --help 探测防递归）。
  caps.resume = true;
  caps.appendSystemPrompt = true;
  return { capabilities: caps, piVersion: deps.version, probedAt: deps.now() };
}

// ── §2 FR9 三级降级链（PRD §13.6 B）：环境信号 → L2；list 失败 → L1 ─────────

export type DegradeLevel = "l0" | "l1" | "l2";

export interface SpawnGateDeps {
  env: Record<string, string | undefined>;
  /**
   * 轻量重探（每次 spawn 前一次 list）：成功且有 panes → resolve null；
   * 失败 → resolve stderr 原文（无 stderr 传空串）或抛 CliError（spawnGate 提取
   * stderr，display runner 原样抛出即此形态）。
   */
  list: () => Promise<string | null>;
}

export interface SpawnGateVerdict {
  level: DegradeLevel;
  /** l1 原因：mux-unreachable（Socket stderr，全 mux 级）| list-failed；l2：env-signals-missing */
  reason?: string;
}

/**
 * L2 判定（spawnGate 前置信号检查的纯函数版）：TERM_PROGRAM=WezTerm 或
 * WEZTERM_UNIX_SOCKET 缺位 → 非 WezTerm 启动环境。index.ts 启动警告复用同口径。
 */
export function isL2Env(env: Record<string, string | undefined>): boolean {
  const termProgram = env["TERM_PROGRAM"];
  const socket = env["WEZTERM_UNIX_SOCKET"];
  return termProgram !== "WezTerm" && (typeof socket !== "string" || socket === "");
}

/**
 * pane 内实例判定（纯，票 03 挂账②：PI_AGENT_TEAMS_PANE 语义显式化，可单测层）：
 * PI_AGENT_TEAMS_PANE 非空且非 "0" → true（wrapper.sh 保证 export PI_AGENT_TEAMS_PANE=1）。
 * 判定为真的语义 = pane 内实例不注册 spawn_visible_agent、不武装 farm ticker
 * （index.ts 装配点在 spawn 注册与 wireFarm 之前 `if (isPaneMode(process.env)) return`；
 * farm_status 只读工具在判定之前注册，pane 内仍可用）。
 * 缺省/""/"0" → false（主会话形态，正常注册 + 武装）。
 */
export function isPaneMode(env: Record<string, string | undefined>): boolean {
  const value = env["PI_AGENT_TEAMS_PANE"];
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * 本进程 depth（PI_AGENT_TEAMS_DEPTH 透传读取，纯）：非负整数串 → 该值；缺省/空串/
 * 非整数/负值 → 0（main）。口径 0-based：main=0、depth-1 角色 agent=1、depth-2 worker=2。
 * 与 isPaneMode 互不耦合（pane 判定不变）。
 */
export function ownDepth(env: Record<string, string | undefined>): number {
  const value = env["PI_AGENT_TEAMS_DEPTH"];
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  return 0;
}

/**
 * spawn 的 depth/form 解析（纯，可单测）：record depth = ownDepth + 1；
 * depth ≥ 2 → 强制 form="worker"（忽略入参 form；formForced=true 时执行层在 ack 附注）。
 */
export function resolveSpawnDepthForm(
  ownDepthValue: number,
  form: "tui" | "worker",
): { depth: number; form: "tui" | "worker"; formForced: boolean } {
  const depth = ownDepthValue + 1;
  if (depth >= 2) return { depth, form: "worker", formForced: true };
  return { depth, form, formForced: false };
}

/**
 * spawn 前降级门（§13.6 B）：
 * - TERM_PROGRAM=WezTerm 或 WEZTERM_UNIX_SOCKET 缺位 → L2（启动环境非 WezTerm）；
 * - 信号在位 → 一次 `wezterm cli --no-auto-start list`：成功且有 panes → L0，
 *   否则 L1（stderr 经 classifyCliFailure 判定 mux-unreachable；list 抛
 *   CliError 时提取其 stderr 同口径；其余失败同样拒派——list 失败即不可派发，
 *   保守不区分运行时错误）。
 */
export async function spawnGate(deps: SpawnGateDeps): Promise<SpawnGateVerdict> {
  if (isL2Env(deps.env)) return { level: "l2", reason: "env-signals-missing" };
  let stderr: string | null;
  try {
    stderr = await deps.list();
  } catch (err) {
    // fake runner/display 层抛 CliError（含 L1 Socket stderr）→ 提取 stderr 继续判定
    stderr = err instanceof CliError ? err.stderr : "";
  }
  if (stderr === null) return { level: "l0" };
  const reason = classifyCliFailure(stderr) === "l1" ? "mux-unreachable" : "list-failed";
  return { level: "l1", reason };
}

/**
 * L1/L2 拒绝文案（不自动路由：只引导内置 subagent 工具，派发拒绝、任务不落盘、
 * 不静默丢失）。l0 调用 → 抛 TypeError（调用方错误，l0 无需拒绝文案）。
 */
export function degradeRejectText(verdict: SpawnGateVerdict): string {
  if (verdict.level === "l0") {
    throw new TypeError("degradeRejectText: l0 无需拒绝文案");
  }
  if (verdict.level === "l2") {
    return "❌ 无法派发：当前环境不是 WezTerm（L2 降级：未检测到 TERM_PROGRAM=WezTerm 或 WEZTERM_UNIX_SOCKET）。已拒绝派发，任务未落盘。请在 WezTerm 中运行 pi 后重试，或改用内置 subagent 工具（同步等待结果）。";
  }
  if (verdict.reason === "mux-unreachable") {
    return "❌ 无法派发：WezTerm GUI/mux 连接失败（L1 降级：全 mux 级，同窗口所有 tab 受影响）。已拒绝派发，任务未落盘。请恢复 WezTerm 后重试，或改用内置 subagent 工具（同步等待结果）。";
  }
  return "❌ 无法派发：WezTerm list 探测失败（L1 降级）。已拒绝派发，任务未落盘。请重试，或改用内置 subagent 工具（同步等待结果）。";
}

// ── §3 spawn 角色枚举校验（US9/US10）────────────────────────────────────────

/**
 * 枚举人设名：目录下 *.md → 去扩展名（非 .md 忽略、空名/./.. 忽略），排序确定性。
 * readDirNames 注入（index 传 readdirSync 返回值；测试传固定数组）；抛错/非数组 → []。
 */
export function listAgentRoles(readDirNames: () => readonly string[]): string[] {
  let names: readonly string[];
  try {
    names = readDirNames();
  } catch {
    return [];
  }
  if (!Array.isArray(names)) return [];
  const roles: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || !name.endsWith(".md")) continue;
    const base = name.slice(0, -".md".length);
    if (base === "" || base === "." || base === "..") continue;
    roles.push(base);
  }
  roles.sort();
  return roles;
}

/**
 * 角色枚举校验（执行时以磁盘枚举为准；schema 枚举仅为注册时快照，防模型瞎编）：
 * - agent 缺省/空串 → null（默认人设，不校验）；
 * - 枚举为空且指定了角色 → 无人设可用文案（提示放置路径，US10）；
 * - 枚举外角色 → 拒绝文案（附可用角色列表，US9）。
 */
export function validateAgentRole(agent: string | undefined, roles: readonly string[]): string | null {
  if (agent === undefined || agent === null) return null;
  const role = typeof agent === "string" ? agent.trim() : "";
  if (role === "") return null;
  if (!Array.isArray(roles) || roles.length === 0) {
    return "❌ 无人设可用：角色目录（~/.pi/agent/agents/）中没有 <name>.md 人设文件。请先放置人设文件（YAML frontmatter + 正文）后 /reload，或改用内置 subagent 工具。";
  }
  if (!roles.includes(role)) {
    return `❌ 未知角色 "${role}"。可用角色：${roles.join(", ")}。请从可用列表中选择（~/.pi/agent/agents/<name>.md），或改用内置 subagent 工具。`;
  }
  return null;
}

// ── §4 farm_status 渲染（US3/US4：5 列表格 + --status 过滤 + <taskId> 详情） ──

/** 7 态全量（--status 过滤枚举；schema 与执行时校验共用） */
export const FARM_STATUS_VALUES = [
  "queued",
  "running",
  "timeout",
  "done",
  "aborted",
  "failed",
  "cancelled",
] as const;
export type FarmStatusFilter = (typeof FARM_STATUS_VALUES)[number];

/** 7 态中文标签（farm.ts STATUS_LABEL 只含终态 4 项，此处补全展示层口径） */
export const FARM_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "运行中",
  timeout: "超时",
  done: "完成",
  aborted: "中止",
  failed: "失败",
  cancelled: "已取消",
};

/** --status 过滤枚举校验（schema 枚举外的执行时兜底；null = 合法不过滤）。 */
export function validateStatusFilter(status: unknown): string | null {
  if (status === undefined || status === null || status === "") return null;
  if (typeof status !== "string" || !FARM_STATUS_VALUES.includes(status as FarmStatusFilter)) {
    return `❌ 未知状态 ${JSON.stringify(String(status))}。可选：${FARM_STATUS_VALUES.join("/")}。`;
  }
  return null;
}

/** 表格行排序：createdAt 升序，taskId 破序（确定性渲染）。 */
export function sortTasksForDisplay(tasks: readonly TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) =>
    a.createdAt !== b.createdAt
      ? a.createdAt - b.createdAt
      : a.taskId < b.taskId
        ? -1
        : a.taskId > b.taskId
          ? 1
          : 0,
  );
}

function spawnRole(task: TaskRecord): string {
  const role = task.payload?.spawn?.role;
  return typeof role === "string" ? role : "";
}

/** 形态（票 06）：payload.spawn.form，缺省 tui（旧记录 normalizeLegacy 补齐） */
function spawnForm(task: TaskRecord): string {
  return task.payload?.spawn?.form === "worker" ? "worker" : "tui";
}

/**
 * B 形态 wrapper env 追加（票 06，评审 R#2 可测接缝）：worker → PI_AGENT_TEAMS_FORM=worker +
 * PI_RENDERER=<path>；tui → []。纯函数，index.ts wrapperCommand 直调。
 */
export function workerFormEnv(form: "tui" | "worker", rendererPath: string): string[] {
  if (form !== "worker") return [];
  return ["PI_AGENT_TEAMS_FORM=worker", `PI_RENDERER=${rendererPath}`];
}

/**
 * 耗时（startedAt 口径，与 farm.done 同源）：未 started（startedAt≤0）→ "—"；
 * 终态 → updatedAt - startedAt；活态（queued/running/timeout）→ now - startedAt。
 */
export function durationText(task: TaskRecord, now: number): string {
  const startedAt =
    typeof task.startedAt === "number" && Number.isFinite(task.startedAt) ? task.startedAt : 0;
  if (startedAt <= 0) return "—";
  const terminal =
    task.status === "done" ||
    task.status === "aborted" ||
    task.status === "failed" ||
    task.status === "cancelled";
  const end = terminal ? task.updatedAt : now;
  return formatDurationMs(Math.max(0, end - startedAt));
}

function padCell(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

/** 面板行数硬顶（票 04：active-only 超 100 折叠；probe/feed 共用，05 复用统一双截断）。 */
export const PANEL_MAX_ROWS = 100;

/**
 * 5 列表格（纯渲染，US3）：taskId 前 8 位 / role / status / attempts / 耗时。
 * 只显示活跃任务（queued|running|timeout）：shown 源 = splitTasksForDisplay(tasks, 0)
 * .active（终态完成即不在面板），sortTasksForDisplay 定序（createdAt ASC + taskId 破序），
 * 行数硬顶 PANEL_MAX_ROWS——超出折叠为「另有 K 条排队」行（footer 前插入）；
 * footer 恒为「活跃 A · 排队 Q · 任务执行完即可清理」（A=活跃总数，Q=其中 queued 数；
 * 「任务执行完即可清理」= 即清语义）。空列表保留表头 + footer（A=Q=0）。
 */
export function renderFarmTable(tasks: readonly TaskRecord[], now: number): string {
  const { active } = splitTasksForDisplay(tasks, 0);
  const sorted = sortTasksForDisplay(active);
  const rows = sorted.slice(0, PANEL_MAX_ROWS).map((task) => {
    const attempts = `${task.attempts}/${task.maxAttempts}`;
    return [
      padCell(task.taskId.slice(0, 8), 8),
      padCell(spawnRole(task) || "-", 12),
      padCell(FARM_STATUS_LABELS[task.status] ?? String(task.status), 8),
      padCell(attempts, 8),
      durationText(task, now),
    ].join(" ");
  });
  const lines = ["taskId   role         status   attempts 耗时", ...rows];
  const folded = sorted.length - PANEL_MAX_ROWS;
  if (folded > 0) lines.push(`另有 ${folded} 条排队`);
  const queued = sorted.filter((task) => task.status === "queued").length;
  lines.push(`活跃 ${sorted.length} · 排队 ${queued} · 任务执行完即可清理`);
  return lines.join("\n");
}

/** nextAttemptAt 渲染：0/缺失 → "—"；未到点附相对时长（退避可预期）。 */
export function formatNextAttemptAt(nextAttemptAt: number, now: number): string {
  if (typeof nextAttemptAt !== "number" || !Number.isFinite(nextAttemptAt) || nextAttemptAt <= 0) {
    return "—";
  }
  const iso = new Date(nextAttemptAt).toISOString();
  const delta = nextAttemptAt - now;
  return delta > 0 ? `${iso}（${formatDurationMs(delta)} 后）` : `${iso}（已到点）`;
}

/**
 * 恢复命令行（纯）：sessionDir 非空且 sessionId 可解析 →
 * `pi -p --session-dir "d" --session "id"`（buildResumeArgs 组装 + "pi" 前缀，
 * 可直接复制执行的完整命令行；形状 pin：["-p","--session-dir",dir,"--session",id]）。
 * 任一缺失 → null。
 */
export function resumeCommandLine(sessionDir: string, sessionId: string | null): string | null {
  if (typeof sessionDir !== "string" || sessionDir === "") return null;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const args = buildResumeArgs(sessionDir, sessionId);
  return `pi -p --session-dir "${args[2]}" --session "${args[4]}"`;
}

function formatEpoch(ms: number): string {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : "—";
}

/** usage 行（FR7）：终态读 result.cost；活态读注入 usage sidecar；无数据 "—"。 */
function usageLine(task: TaskRecord, usage: UsageSidecar | null | undefined): string {
  const terminal =
    task.status === "done" || task.status === "aborted" ||
    task.status === "failed" || task.status === "cancelled";
  if (terminal) {
    const cost = task.result?.cost;
    if (cost && (cost.model !== "" || cost.inputTokens > 0 || cost.outputTokens > 0)) {
      return `usage: ${cost.model || "-"} ↑${cost.inputTokens} ↓${cost.outputTokens}`;
    }
    return "usage: —";
  }
  if (usage !== null && usage !== undefined) {
    return `usage: ${usage.model || "-"} ↑${usage.inputTokens} ↓${usage.outputTokens}`;
  }
  return "usage: —";
}

/**
 * <taskId> 详情（纯渲染，US4）：完整 taskId / role / status / attempts /
 * nextAttemptAt / 恢复命令（buildResumeArgs 完整命令行）/ 耗时（startedAt 口径）/
 * usage（终态 result.cost / 活态注入 usage sidecar）。
 * sessionId 由调用方从 result.sessionDir 解析后注入（I/O 归 index.ts，本函数纯）。
 */
export function renderTaskDetail(
  task: TaskRecord,
  sessionId: string | null,
  now: number,
  usage?: UsageSidecar | null,
): string {
  const resume = resumeCommandLine(task.result?.sessionDir ?? "", sessionId);
  const exitCode = task.result?.exitCode;
  const lines = [
    `taskId: ${task.taskId}`,
    `role: ${spawnRole(task) || "-"}`,
    `form: ${spawnForm(task)}`,
    `status: ${FARM_STATUS_LABELS[task.status] ?? String(task.status)} (${task.status})`,
    `attempts: ${task.attempts}/${task.maxAttempts}`,
    `nextAttemptAt: ${formatNextAttemptAt(task.nextAttemptAt, now)}`,
    `耗时: ${durationText(task, now)}`,
    `startedAt: ${formatEpoch(task.startedAt)}`,
    `updatedAt: ${formatEpoch(task.updatedAt)}`,
  ];
  if (typeof exitCode === "number") lines.push(`exitCode: ${exitCode}`);
  lines.push(usageLine(task, usage));
  lines.push(
    resume !== null
      ? `恢复命令: ${resume}`
      : "恢复命令: 不可用（会话未开始或 sessionDir 缺失）",
  );
  return lines.join("\n");
}

/**
 * 面板刷新节流（票 07 C：数据变化才重刷，防 1s 全量 setWidget 快照式替换闪烁）：
 * prev === null（首拍）→ true（必刷）；否则逐行严格比较——行数或任一内容差异 → true；
 * 全同 → false（跳过 setWidget）。等价于快照指纹比对，零碰撞。
 * 纯函数：不改输入。
 */
export function panelChanged(prev: readonly string[] | null, next: readonly string[]): boolean {
  if (prev === null) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return true;
  }
  return false;
}

// ── §5 排队位置与 ack 文案（US1/US13）───────────────────────────────────────

/**
 * 排队位置（1-based）：queued 任务按 createdAt↑/taskId 破序后，taskId 任务的
 * 名次（含自身）。任务不存在 / 非 queued（已出队或已迁移）→ 0。
 */
export function queuedPosition(tasks: readonly TaskRecord[], taskId: string): number {
  if (!Array.isArray(tasks)) throw new TypeError("queuedPosition: tasks must be an array");
  if (typeof taskId !== "string" || taskId === "") return 0;
  const mine = tasks.find(
    (task) => task !== null && typeof task === "object" && task.taskId === taskId,
  );
  if (mine === undefined || mine.status !== "queued") return 0;
  const ahead = tasks.filter(
    (task) =>
      task !== null &&
      typeof task === "object" &&
      task.taskId !== taskId &&
      task.status === "queued" &&
      (task.createdAt < mine.createdAt ||
        (task.createdAt === mine.createdAt && task.taskId < mine.taskId)),
  );
  return ahead.length + 1;
}

/**
 * spawn 立即返回文案（US1）：position>0 → 「⏳ 已排队，位置 N」（满载）；
 * position=0 → 即将开始。恒含等待纪律（farm.done 到达前不得编造结果）
 * 与同步替代（内置 subagent 工具）。
 */
export function spawnAckText(taskId: string, role: string, position: number, formForced = false): string {
  const rolePart = role !== "" ? `角色=${role}；` : "";
  const queuePart =
    position > 0
      ? `⏳ 已排队，位置 ${position}（并发上限 3，有空位自动开始）`
      : "▶️ 队列有空位，即将在 WezTerm 新 pane 开始";
  const forcedNote = formForced ? "\n（depth-2 任务强制 B 形态：form 入参已忽略）" : "";
  return (
    `✅ 已派发任务 ${taskId}（${rolePart}立即返回，不阻塞等待）。${queuePart}。` +
    `结果以 farm.done 通知到达（taskId/role/status/耗时/exitCode），收到通知前不得编造结果；` +
    `需同步结果请改用内置 subagent 工具。可用 farm_status ${taskId} 查看详情。` +
    forcedNote
  );
}
