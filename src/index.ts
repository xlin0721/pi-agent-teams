// src/index.ts
// pi-agent-teams v3 扩展入口（运行时边界，06 装配票）：注册 spawn_visible_agent /
// farm_status 工具、capability probe 启动执行、装配 display（04）+ task-core（03）+
// farm（05）三件。
//
// 边界纪律：本文件是唯一可 import pi SDK 的模块（v2 部署版同款 import 形态）；
// src/farm.ts、src/display/、src/task-core/ 保持零 pi SDK import（不许破坏）。
// 纯逻辑（probe/降级门/角色校验/farm_status 渲染）归 probe.ts（零依赖，单测覆盖）；
// 本文件只做 I/O 与装配（工具注册/队列接线/session 生命周期），08 smoke 实机验证。
//
// 关键装配点（PRD §13.2/§13.6 + 票 03/04/05）：
// - Queue(store, executor=display 适配 task-core Executor 接口, maxConcurrency=3,
//   owner=pid+启动时间模块加载时生成一次)；
// - Executor.spawn：wrapper env 契约（10 变量，票 07 + PI_BIN/PI_SCRIPT）+ display.spawn
//   → {paneId, sessionDir}（sessionDir = ~/.pi-agent-teams/sessions/<taskId>，先 mkdir）；
//   Executor.steer：no-op 占位（steer 通道 M3）；Executor.kill：display.kill；
// - wireFarm：400ms ticker + 3s pane 探测 + 聚合 followUp 通知（farm.done,
//   deliverAs:"followUp", triggerTurn:true）+ session_shutdown 全 kill（killSync）+
//   GC 7d 口径；
// - wireFarm 的 display 入参过适配层（修复轮：三审计一致 HIGH「装配契约断接」）：
//   04 的 listPanes 返回 PaneInfo 对象数组，farm 契约收 string[]——PaneInfo 经
//   display/adapt.ts（本文件 import）转 pane_id 字符串（缺失/空项剔除），防探测
//   差集把对象当非字符串 → 实际 paneId 集恒空 → 3s 探测循环把 running 全量误判
//   gone 注入 aborted 误杀；
// - PI_AGENT_TEAMS_PANE=1（pane 内）：不注册 spawn、不 wireFarm（M2 临时语义，防嵌套
//   农场）；farm_status 仍注册（只读）；
// - capability probe：启动执行写 ~/.pi-agent-teams/config.json（§13.6 A 五项，
//   失败单项=false 不阻断）。
//
// node 22 type-stripping 约束：禁 enum/namespace/构造器参数属性（本文件均未使用）。

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import { DisplayClient } from "./display/split.ts";
import { computePlacementFromSnapshot } from "./display/grid.ts";
import type { GridPlacement } from "./display/grid.ts";
import { adaptListPanes } from "./display/adapt.ts";
import { TaskStore } from "./task-core/store.ts";
import type { TaskRecord } from "./task-core/store.ts";
import { Queue, parseUsageSidecar } from "./task-core/queue.ts";
import type { Executor, UsageSidecar } from "./task-core/queue.ts";
import { findSessionId } from "./task-core/resume.ts";
import { wireFarm } from "./farm.ts";
import { Inbox } from "./task-core/steer.ts";
import { createWaiter } from "./sync-wait.ts";
import type { Waiter } from "./sync-wait.ts";
import type { InboxMessage } from "./task-core/steer.ts";
import { executeSteer, steerBubbleLines, type SteerToolParams, buildSteerSink, resolveOwnPaneId, executeMsg, executeResume, resolveMsgFrom, resolveMsgTargets, resolveMeetingTargets, type MsgToolParams, type ResumeToolParams } from "./steer-tool.ts";
import { resolveWorkspaceRoot, WS_ENV } from "./workspace.ts";
import { pollInbox, readInboxSnapshot } from "./comm/inbox.ts";
import {
  closeRound,
  getActiveRound,
  isMeetingBroadcast,
  isSynthesizable,
  openRound,
  recordReply,
  setActiveRound,
  supersede,
  synthesize,
} from "./comm/meeting.ts";
import { buildFeed } from "./comm/feed.ts";
import { DEFAULT_PRICING_TABLE, parsePricingTable } from "./pricing.ts";
import type { PricingTable } from "./pricing.ts";
import { PRESENCE_HEARTBEAT_MS, readPresences, writePresence } from "./comm/presence.ts";
import {
  FARM_STATUS_VALUES,
  degradeRejectText,
  isL2Env,
  isPaneMode,
  listAgentRoles,
  ownDepth,
  panelChanged,
  queuedPosition,
  renderFarmTable,
  renderTaskDetail,
  resolveSpawnDepthForm,
  runProbe,
  sortTasksForDisplay,
  spawnAckText,
  spawnGate,
  validateAgentRole,
  validateStatusFilter,
  workerFormEnv,
} from "./probe.ts";

// ── 常量 ─────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
/** 工作区隔离（C1）：FARM_ROOT=~/.pi-agent-teams/<wsId> 派生（env 显式 > cwd 派生）；
 *  GLOBAL_ROOT=~/.pi-agent-teams（pricing/config 全局配置，不随工作区分区）。 */
const WS = resolveWorkspaceRoot({
  cwd: process.cwd(),
  home: homedir(),
  envRoot: process.env[WS_ENV] ?? undefined,
});
const FARM_ROOT = WS.farmRoot;
const GLOBAL_ROOT = WS.globalRoot;
/** 启动日志（E5）：输出工作区根解析结果——pane/main 一致性排查与双区并存检测（premortem Top2）。 */
console.log(
  `[pi-agent-teams] workspace root: ${WS.farmRoot} (source=${WS.source}` +
    `${WS.source === "derived" ? `, wsId=${WS.workspaceId}` : ""}, global=${WS.globalRoot})`,
);
const AGENTS_DIR = join(getAgentDir(), "agents");
/** 人设枚举同时看用户目录（getAgentDir）——项目级 .pi/agents 不在 M2 枚举范围 */
const DEFAULT_TIMEOUT_SECS = 600;
const MAX_ATTEMPTS = 2;
const BACKOFF_SECS = [5, 30];
const MAX_CONCURRENCY = 3;
/** 本进程 owner（pid+启动时间，模块加载时生成一次；farm.parseOwnerPid 消费该格式） */
const OWNER = `${process.pid}+${Date.now()}`;

// ── 启动资产与 pi 探测（v2 部署版同款模式） ─────────────────────────────────

/** pi 调用探测结果缓存（模块加载时探测一次；spawn env 注入与启动 probe 共用同源） */
const PI_INVOCATION = detectPiInvocation();

/** wrapper.sh 资产定位：部署形态（assets/ 与 index.ts 同目录）> 仓库形态（../assets） */
function findWrapperAsset(): string | null {
  const candidates = [
    join(HERE, "assets", "wrapper.sh"),
    join(HERE, "..", "assets", "wrapper.sh"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** 首启资产：mkdir 农场目录 + 每次加载覆盖部署 wrapper.sh（与安装版保持同步） */
function ensureFarmAssets(): void {
  mkdirSync(join(FARM_ROOT, "requests"), { recursive: true });
  mkdirSync(join(FARM_ROOT, "status"), { recursive: true });
  mkdirSync(join(FARM_ROOT, "sessions"), { recursive: true });
  const source = findWrapperAsset();
  if (source === null) {
    console.warn("pi-agent-teams: 未找到 assets/wrapper.sh（部署形态 assets/ 或仓库形态 ../assets/），spawn 将失败");
    return;
  }
  const destination = join(FARM_ROOT, "wrapper.sh");
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
}

/** pi 调用探测（v2 同款）：当前运行脚本 > $SHELL -lc "command -v pi" > 默认路径 */
function detectPiInvocation(): { piBin: string; piScript: string } {
  const current = process.argv[1];
  if (current && !current.startsWith("/$bunfs/") && existsSync(current)) {
    // piScript 绝对化：wrapper 会先 cd 到任务 CWD，相对路径会失锚
    return { piBin: process.execPath, piScript: resolve(current) };
  }
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const found = execFileSync(shell, ["-lc", "command -v pi"]).toString().trim();
    if (found) return { piBin: found, piScript: "" };
  } catch {
    // fall through
  }
  return { piBin: "/usr/local/bin/pi", piScript: "" };
}

/**
 * 启动探测（§13.6 A 五项）：写 config.json。形状 = probe 结果 + piBin/piScript
 * （v2 遗留字段保留，防 08 切换前 v2 部署版视 config 为 stale 反复覆盖）。
 * 探测失败不阻断扩展加载（单项失败已在 runProbe 内降级为 false）。
 */
async function runStartupProbe(pi: ExtensionAPI): Promise<void> {
  try {
    const invocation = PI_INVOCATION;
    const result = await runProbe({
      pi: {
        sendMessage: (message: unknown, options: unknown) => pi.sendMessage(message as never, options as never),
        getActiveTools: () => pi.getActiveTools(),
        setActiveTools: (names) => pi.setActiveTools(names as string[]),
      },
      env: process.env,
      now: () => Date.now(),
      version: VERSION,
    });
    const config = {
      ...result,
      piBin: invocation.piBin,
      piScript: invocation.piScript,
    };
    writeFileSync(join(GLOBAL_ROOT, "config.json"), JSON.stringify(config, null, 2));
  } catch {
    // 探测失败不阻断扩展加载
  }
}

// ── 人设（US33）：parseFrontmatter 取 body → 临时文件 → PERSONA_FILE env ─────

/**
 * 人设解析 + 落盘：<agentDir>/<name>.md → parseFrontmatter 取 body（frontmatter.name
 * 与角色名一致才认，v2 口径）→ requests/<taskId>.agent-prompt（GC 1h 口径回收）。
 * 文件缺失/body 空 → 拒绝（US10，不静默降级为无人设）。
 */
function stagePersona(role: string, taskId: string): { ok: true; file: string } | { ok: false; error: string } {
  const path = join(AGENTS_DIR, `${role}.md`);
  try {
    if (!existsSync(path)) {
      return {
        ok: false,
        error: `❌ 角色 "${role}" 的人设文件缺失：${path}。请补齐后 /reload，或改用内置 subagent 工具。`,
      };
    }
    const parsed = parseFrontmatter(readFileSync(path, "utf8"));
    const declaredName = parsed.frontmatter?.["name"];
    if (typeof declaredName === "string" && declaredName !== "" && declaredName !== role) {
      return {
        ok: false,
        error: `❌ 角色 "${role}" 的人设 frontmatter.name 为 "${declaredName}"，与文件名不符。请修正后 /reload，或改用内置 subagent 工具。`,
      };
    }
    const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (body === "") {
      return {
        ok: false,
        error: `❌ 角色 "${role}" 的人设 body 为空：${path}。请补齐正文后 /reload，或改用内置 subagent 工具。`,
      };
    }
    const file = join(FARM_ROOT, "requests", `${taskId}.agent-prompt`);
    writeFileSync(file, body, "utf8");
    return { ok: true, file };
  } catch {
    return {
      ok: false,
      error: `❌ 角色 "${role}" 的人设文件不可读：${path}。请检查权限后重试，或改用内置 subagent 工具。`,
    };
  }
}

// ── Executor：display 适配 task-core Executor 接口（票 03 声明 / 04 实现） ────

/** 任务 pane 标题：`[role] prompt 前 40 字`（payload.spawn 无 title 字段，派生口径） */
function deriveTitle(role: string, prompt: string): string {
  const snippet = prompt.replace(/\s+/g, " ").trim().slice(0, 40);
  const base = snippet === "" ? "subagent" : snippet;
  return role !== "" ? `[${role}] ${base}` : base;
}

/** 人设临时文件路径（stagePersona 的确定性落点；存在才传给 wrapper） */
function personaFileFor(taskId: string): string {
  const file = join(FARM_ROOT, "requests", `${taskId}.agent-prompt`);
  return existsSync(file) ? file : "";
}

/**
 * wrapper env 契约（票 07，9 变量 + 累计补 5（票 07 补 PI_BIN/PI_SCRIPT，票 09 补 PI_NODE，
 * 本票补 PI_AGENT_TEAMS_DEPTH，票 08 补 PI_AGENT_TEAMS_RESUME））→ display.spawn cmd。
 * wezterm split-pane 无 shell 解析（`-- PROG [ARGS]` 直接 exec），env 赋值项作为
 * /usr/bin/env 的直接 argv（值可含空格/等号，无 shell 注入面）。
 * PI_BIN/PI_SCRIPT = 主会话探测到的 pi 调用路径（单点真源）：wrapper 优先用之，
 * 非 login PATH 差异下仍与主会话同一 pi，不再自探测。
 * PI_AGENT_TEAMS_DEPTH = task record 的 depth（=ownDepth+1）：main 派 depth-1 角色 agent 传 1，
 * 角色 agent 派 depth-2 worker 传 2；被派进程读之知自身深度。
 * PI_AGENT_TEAMS_RESUME = payload.spawn.resumeFrom（票 08）：非空则 wrapper 以 --session 恢复
 * 会话（不注入 prompt），否则新起 prompt。
 */
function wrapperCommand(task: TaskRecord, sessionDir: string, cwd: string): string[] {
  const spawnPayload = task.payload.spawn;
  const form = spawnPayload.form ?? "tui";
  const args = [
    "/usr/bin/env",
    `PI_AGENT_TEAMS_TASK_ID=${task.taskId}`,
    `PI_AGENT_TEAMS_DEPTH=${task.depth}`,
    `PI_AGENT_TEAMS_ROOT=${FARM_ROOT}`,
    `DONE_FILE=${join(FARM_ROOT, "status", `${task.taskId}.done`)}`,
    `ABORT_FILE=${join(FARM_ROOT, "status", `${task.taskId}.aborted`)}`,
    `SESS_DIR=${sessionDir}`,
    `TITLE=${deriveTitle(spawnPayload.role, spawnPayload.prompt)}`,
    `CWD=${cwd}`,
    `PI_BIN=${PI_INVOCATION.piBin}`,
    `PI_NODE=${process.execPath}`,
  ];
  if (PI_INVOCATION.piScript !== "") args.push(`PI_SCRIPT=${PI_INVOCATION.piScript}`);
  if (spawnPayload.resumeFrom !== null && spawnPayload.resumeFrom !== "") {
    args.push(`PI_AGENT_TEAMS_RESUME=${spawnPayload.resumeFrom}`);
  }
  const persona = personaFileFor(task.taskId);
  if (persona !== "") args.push(`PERSONA_FILE=${persona}`);
  if (form === "worker") {
    // B 形态（票 06）：PI_AGENT_TEAMS_FORM 切 wrapper B 分支；PI_RENDERER = render-mini.ts
    // 绝对路径（两形态同形：仓库 src/ 与部署扩展根均与 display/ 同级，backend#11）。
    args.push(...workerFormEnv(form, join(HERE, "display", "render-mini.ts")));
  }
  args.push("bash", join(FARM_ROOT, "wrapper.sh"));
  return args;
}

function makeExecutor(display: DisplayClient): Executor {
  return {
    /** 起 pane：sessionDir 先 mkdir（wrapper env 依赖）→ split-pane → {paneId, sessionDir} */
    async spawn(task: TaskRecord): Promise<{ paneId: string; sessionDir: string }> {
      const sessionDir = join(FARM_ROOT, "sessions", task.taskId);
      await mkdir(sessionDir, { recursive: true });
      const spawnPayload = task.payload.spawn;
      const cwd = spawnPayload.cwd !== "" ? spawnPayload.cwd : homedir();
      // 网格落点（best-effort）：listPanes 快照 + WEZTERM_PANE 决策下沉 grid.ts；
      // 任何异常回退 undefined → display.spawn 走默认 --right，spawn 永不因网格计算失败而失败。
      let placement: GridPlacement | undefined;
      try {
        const panes = await display.listPanes();
        placement = computePlacementFromSnapshot(panes, process.env["WEZTERM_PANE"]) ?? undefined;
      } catch {
        placement = undefined;
      }
      const paneId = await display.spawn(wrapperCommand(task, sessionDir, cwd), { cwd, placement });
      return { paneId, sessionDir };
    },
    /** steer 通道 M3 实现；M2 占位 no-op（Queue 的 killPane/steer 路径不调用） */
    async steer(): Promise<void> {
      // no-op 占位（M3）
    },
    /**
     * 杀 pane（修复轮同步 task-core）：入参已是 paneId（killPane 传落盘
     * paneId / 写回失败孤儿 pane 传 spawn 返回值），无需 readTask 解析；
     * 空串 = 无可杀，跳过。
     */
    async kill(paneId: string): Promise<void> {
      if (paneId === "") return;
      await display.kill(paneId);
    },
  };
}

// ── spawn_visible_agent 工具（US1/US9/US10/US11/US12/US13）───────────────────


/** 排队落盘记录（schema 见 store.ts；§13.3 字段全量，owner 写本进程） */
function buildTaskRecord(input: {
  taskId: string;
  prompt: string;
  role: string;
  cwd: string;
  timeoutSecs: number;
  now: number;
  depth: number;
  form: "tui" | "worker";
}): TaskRecord {
  const { taskId, prompt, role, cwd, timeoutSecs, now, depth, form } = input;
  return {
    taskId,
    type: "spawn",
    parentId: null,
    // depth = ownDepth+1（main=1 / 角色 agent=2）；depth≥2 由 resolveSpawnDepthForm
    // 强制 worker（form 单点写在 enqueue，Queue 层只透传 record）。
    depth,
    status: "queued",
    owner: OWNER,
    createdAt: now,
    updatedAt: now,
    startedAt: 0,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs,
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    backoffSecs: BACKOFF_SECS,
    payload: {
      spawn: { role, prompt, cwd, resumeFrom: null, paneId: "", form },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: ["all"], delivery: "notice", content: "" },
      schedule: { mode: "once", cron: "", intervalSecs: 0, onceAt: 0, lastRun: 0, nextRun: 0, firedTaskIds: [] },
    },
    result: { sessionDir: "", exitCode: null, cost: { model: "", inputTokens: 0, outputTokens: 0 } },
  };
}

export interface SpawnToolInput {
  task: string;
  agent?: string;
  cwd?: string;
  timeout_secs?: number;
  /** 形态（票 06）：缺省 tui；worker = B 形态状态窗口（pane 内 ANSI 看板 + 背后无头 agent） */
  form?: "tui" | "worker";
  /** 票 05：true = 阻塞至任务终态并返回结果（spawn-and-wait 语义）；缺省 false = 现有异步零变化 */
  sync?: boolean;
  /** 票 05：sync 等待超时秒数（缺省 120，上限 600；含排队时长） */
  wait_timeout_secs?: number;
}

interface SpawnDeps {
  display: DisplayClient;
  store: TaskStore;
  /** 票 05：sync:true 等待器（main/depth-1 装配时传入；缺失时 sync 参数回落异步） */
  waiter?: Waiter;
  /** 票 04：consumed/notifiedAt 写入的农场根（sync 返回路径） */
  farmRoot?: string;
}

/** 票 05：sync 等待超时缺省（spec D2：120s，上限 600；premortem 建议 + spike 实证） */
const SYNC_WAIT_TIMEOUT_SECS = 120;
const SYNC_WAIT_TIMEOUT_MAX_SECS = 600;

/**
 * pi 扩展 execute 的 onUpdate 契约（M8 修复：曾误当字符串回调透传，导致 TUI
 * `{...partialResult}` 展开字符串 → result.content undefined → getTextOutput
 * undefined.filter 崩溃）。真实契约 = 对象 {content:[{type:"text",text}]}（与
 * 工具返回值同构，作 partialResult；bash 工具同款用法）。
 */
export type ToolOnUpdate = (update: { content: unknown[]; details?: unknown }) => void;

/** sync 等待心跳适配：纯逻辑消息字符串 → pi onUpdate 对象契约（M8 修复）。 */
function heartbeatToOnUpdate(onUpdate: ToolOnUpdate | undefined) {
  return (message: string): void => {
    try {
      onUpdate?.({ content: [{ type: "text", text: message }] });
    } catch {
      // 心跳上报失败不阻断等待
    }
  };
}

/** 写 status/<id>.consumed（评审 R1：sync 等到终态返回后写；O_EXCL 原子创建防并发）。 */
async function writeConsumed(farmRoot: string, taskId: string): Promise<void> {
  try {
    await mkdir(join(farmRoot, "status"), { recursive: true });
    await writeFile(join(farmRoot, "status", `${taskId}.consumed`), String(Date.now()), { flag: "wx" });
  } catch {
    // 已存在（wx 冲突）或不可写 → 幂等忽略
  }
}

/**
 * spawn 执行（不注册 spawn 的 pane 内实例永不调用）：
 * 1) 角色枚举校验（执行时以磁盘枚举为准；schema 枚举只是注册时快照，防模型瞎编）；
 * 2) FR9 降级门：每次 spawn 前轻量重探（一次 listPanes）——L1/L2 拒绝 + 文案引导
 *    内置 subagent 工具（不自动路由），任务不落盘不静默丢失；
 * 3) 人设 body 落盘 → 4) 组装 record + writeTask 入队 → 5) 立即返回
 *    taskId + 排队位置（满载「已排队，位置 N」）；
 * 6) 票 05：sync:true → 不立即返回 ack，转入 sync-wait 阻塞至终态/超时/abort，
 *    返回统一形状 {taskId, status, exitCode, sessionDir, result, cost, waitedMs,
 *    unfinished, timeout}；返回前写 consumed 标记（评审 R1①）与 notifiedAt 写回
 *    （评审 R1③：filterReplay 天然排除，跨重启不重复通知）。
 */
async function executeSpawn(
  params: SpawnToolInput,
  ctx: { cwd?: string },
  deps: SpawnDeps,
  signal?: AbortSignal,
  onUpdate?: ToolOnUpdate,
): Promise<unknown> {
  const roles = listAgentRoles(() => readdirSync(AGENTS_DIR));
  const roleError = validateAgentRole(params.agent, roles);
  if (roleError !== null) {
    return { content: [{ type: "text", text: roleError }] };
  }

  // 降级门（在任务落盘之前：L1/L2 拒派不产生任何任务文件）
  const gate = await spawnGate({
    env: process.env,
    list: async () => {
      // display 层 CliError 原样抛出（spawnGate 提取 stderr 判定 L1）
      const panes = await deps.display.listPanes();
      return panes.length > 0 ? null : ""; // §13.6：exit 0 且有 panes → L0，否则 L1
    },
  });
  if (gate.level !== "l0") {
    return { content: [{ type: "text", text: degradeRejectText(gate) }] };
  }

  const now = Date.now();
  const taskId = randomUUID().slice(0, 12);
  const role = typeof params.agent === "string" ? params.agent.trim() : "";

  if (role !== "") {
    const staged = stagePersona(role, taskId);
    if (!staged.ok) {
      return { content: [{ type: "text", text: staged.error }] };
    }
  }

  const cwd = typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : (ctx.cwd ?? homedir());
  // depth/form 单点解析（纯函数 resolveSpawnDepthForm，可单测）：record depth = ownDepth+1；
  // depth≥2 强制 form="worker"（忽略入参 form）。非法 form 值由 schema StringEnum 拒绝（票 06）。
  const { depth, form, formForced } = resolveSpawnDepthForm(ownDepth(process.env), params.form ?? "tui");
  const record = buildTaskRecord({
    taskId,
    prompt: params.task,
    role,
    cwd,
    timeoutSecs: params.timeout_secs ?? DEFAULT_TIMEOUT_SECS,
    now,
    depth,
    form,
  });
  await deps.store.writeTask(record);

  // 票 05：sync:true → 阻塞等待至终态并返回结果（不立即返回 ack）
  if (params.sync === true && deps.waiter !== undefined && deps.farmRoot !== undefined) {
    const timeoutSecs =
      params.wait_timeout_secs !== undefined
        ? Math.min(Math.max(params.wait_timeout_secs, 1), SYNC_WAIT_TIMEOUT_MAX_SECS)
        : SYNC_WAIT_TIMEOUT_SECS;
    const outcome = await deps.waiter.wait(taskId, {
      timeoutMs: timeoutSecs * 1000,
      signal,
      onProgress: heartbeatToOnUpdate(onUpdate),
    });
    // 评审 R1①：consumed 标记（原子创建，幂等）
    await writeConsumed(deps.farmRoot, taskId);
    // 评审 R1③：notifiedAt 写回（与 deliver 同守卫：owner==本进程）→ filterReplay 排除
    const rec = await deps.store.readTask(taskId);
    if (rec !== null && rec.owner === OWNER) {
      await deps.store.writeTask({ ...rec, notifiedAt: Date.now() });
    }
    if (outcome.unfinished) {
      const guidance =
        outcome.timeout
          ? `等待超时（${timeoutSecs}s，含排队时长），任务仍在运行。用 farm_status ${taskId} 查状态；若已 aborted 可用 farm_resume ${taskId} 恢复。`
          : `等待被取消，任务仍在运行。用 farm_status ${taskId} 查状态。`;
      return {
        content: [
          {
            type: "text",
            text: `⏳ ${guidance}\n${JSON.stringify(
              { taskId, status: outcome.status, unfinished: true, timeout: outcome.timeout },
              null,
              2,
            )}`,
          },
        ],
        details: { taskId, role, sync: true, unfinished: true, timeout: outcome.timeout },
      };
    }
    const summary = outcome.resultSource === "none" ? "" : outcome.result;
    return {
      content: [
        {
          type: "text",
          text: `✅ 任务 ${taskId} 完成（${outcome.status}，耗时 ${(outcome.waitedMs / 1000).toFixed(1)}s）\n` +
            `exitCode: ${outcome.exitCode ?? "-"}\n` +
            `模型: ${outcome.cost.model || "-"}（↑${outcome.cost.inputTokens} ↓${outcome.cost.outputTokens}）\n` +
            (summary !== "" ? `结果摘要:\n${summary.slice(0, 2000)}\n` : "") +
            `sessionDir: ${outcome.sessionDir}\n` +
            `完整会话见 sessionDir；结果来源: ${outcome.resultSource}`,
        },
      ],
      details: {
        taskId,
        role,
        status: outcome.status,
        exitCode: outcome.exitCode,
        sessionDir: outcome.sessionDir,
        resultSource: outcome.resultSource,
        cost: outcome.cost,
        waitedMs: outcome.waitedMs,
        sync: true,
      },
    };
  }

  const all = await deps.store.scanTasks(null);
  const position = queuedPosition(all, taskId);
  return {
    content: [{ type: "text", text: spawnAckText(taskId, role, position, formForced) }],
    details: { taskId, role, status: "queued", position },
  };
}

// ── farm_status 工具（US3/US4：5 列表格 + --status 过滤 + <taskId> 详情）─────

interface FarmStatusDeps {
  store: TaskStore;
}

async function executeFarmStatus(
  params: { status?: string; taskId?: string },
  deps: FarmStatusDeps,
): Promise<unknown> {
  const now = Date.now();
  const tasks = await deps.store.scanTasks(null); // 全量（含双会话/存量记录）

  if (typeof params.taskId === "string" && params.taskId !== "") {
    const task = tasks.find((candidate) => candidate.taskId === params.taskId);
    if (task === undefined) {
      return {
        content: [{ type: "text", text: `❌ 未找到任务 ${params.taskId}。可用 farm_status（无参数）查看全列表。` }],
      };
    }
    const sessionId = await findSessionId(task.result?.sessionDir ?? "");
    return { content: [{ type: "text", text: renderTaskDetail(task, sessionId, now) }] };
  }

  const filterError = validateStatusFilter(params.status);
  if (filterError !== null) {
    return { content: [{ type: "text", text: filterError }] };
  }
  const filtered =
    typeof params.status === "string" && params.status !== ""
      ? tasks.filter((task) => task.status === params.status)
      : tasks;
  return { content: [{ type: "text", text: renderFarmTable(filtered, now) }] };
}

// ── pane 侧武装（depth-1 角色 agent mini-farm / depth-2 零工具） ─────────────

/** pane 侧双循环武装锚点（presence 3s + comm 400ms 各自独立；镜像 farm.ts active
 *  句柄先例，reload 不残留双循环；pane 进程随窗关闭自然销毁）。 */
let panePresenceArmed = false;
let paneCommReaderArmed = false;

/**
 * presence 写者（BE#3 挂点）：每 3s 原子写 own presence（<root>/presence/<taskId>.json，
 * 写者 = 自身 pane 进程，单写者矩阵合法）。taskId 缺省 / record 缺失 / paneId 未回写
 * → 本拍跳过（main Queue spawn 后 ~1s 写回 paneId）。
 */
function wirePanePresence(store: TaskStore, ownDepthValue: number): void {
  const taskId = process.env["PI_AGENT_TEAMS_TASK_ID"] ?? "";
  if (taskId === "") return;
  if (panePresenceArmed) return;
  panePresenceArmed = true;
  const heartbeat = async () => {
    try {
      const record = await store.readTask(taskId);
      if (record === null) return;
      const paneId = record.payload?.spawn?.paneId ?? "";
      if (paneId === "") return; // paneId 未回写：本拍跳过（main Queue spawn 后 ~1s 写回）
      await writePresence(FARM_ROOT, {
        taskId,
        paneId,
        role: record.payload?.spawn?.role ?? "",
        depth: ownDepthValue,
        pid: process.pid,
      });
    } catch {
      // 单拍失败不崩
    }
  };
  setInterval(() => {
    void heartbeat();
  }, PRESENCE_HEARTBEAT_MS);
}

/**
 * comm reader（depth-1 steer/msg 送达）：解析自身 paneId 后 400ms pollInbox 轮询，
 * steer/msg 消息经 buildSteerSink 投进本会话（票 04 起 sink 同时收 steer + msg）。
 * 30s 未回写 paneId → 跳过 inbox（下会话/重试自然恢复）。
 */
function armPaneCommReader(pi: ExtensionAPI, store: TaskStore): void {
  // D2 装配门（C9 读侧兜底双保险）：depth≥2 worker 不 arm comm reader——B 形态本就不
  // 收 steer/msg；env 丢失时 fail-closed（不 arm = 不收信，宁缺毋劫持）。
  if (ownDepth(process.env) >= 2) return;
  const taskId = process.env["PI_AGENT_TEAMS_TASK_ID"] ?? "";
  if (taskId === "") return;
  if (paneCommReaderArmed) return;
  paneCommReaderArmed = true;
  void (async () => {
    const paneId = await resolveOwnPaneId((id) => store.readTask(id), taskId, { timeoutMs: 30_000 });
    if (paneId === "") return; // 30s 未回写：跳过 inbox（下会话/重试自然恢复）
    setInterval(() => {
      void pollInbox(FARM_ROOT, paneId, buildSteerSink(pi));
    }, 400);
  })();
}

// ── main 侧 comm reader 武装（票 03） ────────────────────────────────────────

/** main-only 武装锚点（镜像 paneCommReaderArmed 先例：reload 不残留双循环）。 */
let mainCommReaderArmed = false;

/**
 * main 收件接线（票 03 + 票 04）：400ms pollInbox 轮询 inbox/main。meetingSink 先经
 * recordReply 把回复记进活跃轮（getActiveRound() 为 null 时容错 no-op），再经
 * buildSteerSink 投进主会话（notice=followUp 不 triggerTurn / directive=steer+triggerTurn）。
 *
 * 票 04 完成合成（正确性关键）：合成检查放 interval 回调内（pollInbox(...).then(...)
 * 之后），不能只放 sink 内——否则「超时弃权轮（0 回复或部分回复后无新消息）」永不
 * 触发合成。每 tick：pollInbox 投递（sink 内 recordReply）→ then 回调查 isSynthesizable
 * → 达成则 closeRound（锁幂等）→ synthesize → farm.meeting followUp+triggerTurn（对齐
 * farm.done 先例，非 steer）。roleOf 经 readPresences 译 paneId→角色名，缺失回退 paneId。
 */
function armMainCommReader(pi: ExtensionAPI): void {
  if (mainCommReaderArmed) return;
  mainCommReaderArmed = true;
  const sink = buildSteerSink(pi);
  const meetingSink = (msg: InboxMessage) => {
    recordReply(getActiveRound(), msg.from, msg.content);
    return sink(msg);
  };
  setInterval(() => {
    void (async () => {
      await pollInbox(FARM_ROOT, "main", meetingSink);
      const round = getActiveRound();
      if (round === null || round.closed) return;
      const now = Date.now();
      if (!isSynthesizable(round, now)) return;
      closeRound(round); // 幂等锁：先关轮，迟到回复不再二次合成
      const presences = await readPresences(FARM_ROOT);
      const roleOf = (paneId: string): string => {
        const p = presences.find((x) => x.paneId === paneId);
        return p !== undefined && p.role !== "" ? p.role : paneId;
      };
      const content = synthesize(round, roleOf, now);
      pi.sendMessage(
        { customType: "farm.meeting", content, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
    })();
  }, 400);
}

/**
 * depth-1 角色 agent mini-farm 装配：独立 Queue（per-farm 并发预算）+ spawn 工具
 * （ownDepth(env)=1 → resolveSpawnDepthForm 强制 depth=2 + form=worker）+ comm
 * reader + wireFarm（gcEnabled:false——GC 只在 main）。
 */
function assembleMiniFarm(
  pi: ExtensionAPI,
  deps: { display: DisplayClient; store: TaskStore; agentRoles: string[]; inbox: Inbox },
): void {
  // BE#1：per-farm 独立并发预算——Queue.step 内 runningCount 只计本 owner running
  const queue = new Queue({
    store: deps.store,
    executor: makeExecutor(deps.display), // 复用 Executor：spawn → depth-2 worker pane
    maxConcurrency: MAX_CONCURRENCY,
    owner: OWNER, // 本 pane 进程 pid+启动时间（模块级常量）
  });

  // 票 02/05：sync 等待器（本 farm 的 spawn sync:true 用；isConsumed 供 wireFarm 去重）
  const waiter = createWaiter({ store: deps.store, farmRoot: FARM_ROOT });

  // spawn_visible_agent：executeSpawn 共享，ownDepth(env)=1 → resolveSpawnDepthForm
  // 强制 depth=2 + form=worker
  pi.registerTool({
    name: "spawn_visible_agent",
    label: "Spawn Visible Agent",
    description:
      "Spawn a subagent in a NEW WezTerm pane (split to the right) with LIVE output, so the user " +
      "can watch this role agent session and the subagent's progress simultaneously. " +
      "本进程为 depth-1 角色 agent：派发恒为 depth-2 worker（B 形态），form 入参被忽略。 " +
      "The tool returns IMMEDIATELY with a taskId (no blocking wait; when the queue is full it reports 「已排队，位置 N」). " +
      "Results arrive as a farm.done notification (taskId/role/status/耗时/exitCode) — NEVER fabricate " +
      "or assume the task's result before the farm.done notification arrives. If you need the result " +
      "synchronously (blocking), use the built-in subagent tool instead. " +
      "Optional agent persona: resolved from ~/.pi/agent/agents/<name>.md" +
      (deps.agentRoles.length > 0 ? ` (available: ${deps.agentRoles.join(", ")})` : " (currently none available)") +
      ". Check progress anytime with farm_status <taskId>.",
    promptGuidelines: [
      "Use spawn_visible_agent when you need a subagent — the user wants ALL subagents visible in split panes.",
      "spawn_visible_agent returns a taskId immediately; results arrive as a farm.done notification. Never fabricate or assume the task's result before that notification arrives.",
      "Use the built-in subagent tool instead of spawn_visible_agent when you need the result synchronously.",
      "Pass agent as one of the enumerated persona names; other names are rejected.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task prompt for the subagent" }),
      agent:
        deps.agentRoles.length > 0
          ? Type.Optional(StringEnum(deps.agentRoles as unknown as readonly [string, ...string[]]))
          : Type.Optional(
              Type.String({
                description:
                  "Agent persona name. 当前无人设可用：请在 ~/.pi/agent/agents/<name>.md 放置人设文件后 /reload。",
              }),
            ),
      cwd: Type.Optional(Type.String({ description: "Working directory for the subagent; default: current directory" })),
      timeout_secs: Type.Optional(
        Type.Integer({ minimum: 1, description: "Per-attempt timeout seconds; on timeout the task retries with backoff (default 600)" }),
      ),
      form: Type.Optional(StringEnum(["tui", "worker"])),
      sync: Type.Optional(Type.Boolean({ description: "true = 阻塞至任务终态并返回结果（spawn-and-wait）；缺省 false = 异步立即返回 taskId" })),
      wait_timeout_secs: Type.Optional(
        Type.Integer({ minimum: 1, description: "sync 等待超时秒数（缺省 120，上限 600；含排队时长）" }),
      ),
    }),
    prepareArguments(args: unknown) {
      if (args === null || typeof args !== "object") return args;
      const { title: _title, destroy_delay_secs: _delay, ...rest } = args as Record<string, unknown>;
      return rest;
    },
    async execute(_toolCallId: unknown, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) {
      return executeSpawn(
        params as SpawnToolInput,
        ctx as { cwd?: string },
        { display: deps.display, store: deps.store, waiter: waiter, farmRoot: FARM_ROOT },
        signal as AbortSignal,
        onUpdate as ToolOnUpdate,
      );
    },
  });

  // mini-farm 循环：gcEnabled:false（GC 只在 main）+ replayDeadOwner:false
  // （跨重启补发只在 main——depth-1 角色 agent 不接管 main 层死 owner 任务，
  //   否则 farm.done 通知 triggerTurn 抢初始 prompt 回合，见 SMOKE-D-REPORT.md Bug A）
  wireFarm({
    queue,
    display: {
      spawn: (cmd: string[], opts: { cwd?: string } = {}) => deps.display.spawn(cmd, opts),
      listPanes: async () => adaptListPanes(await deps.display.listPanes()),
      kill: (paneId: string) => deps.display.kill(paneId),
      killSync: (paneId: string) => deps.display.killSync(paneId),
    },
    pi,
    owner: OWNER,
    notify: async (message) => {
      // D7：farm.done 通知发父会话（角色 agent 自己的 pi.sendMessage followUp），不直发 main
      pi.sendMessage(
        { customType: "farm.done", content: message.text, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
    farmRoot: FARM_ROOT,
    gcEnabled: false,
    replayDeadOwner: false,
    // 票 04（评审 R1②）：sync 已消费的终态不发 farm.done（共享 deliver 出口，flush+replay 双路径）
    isConsumed: async (taskId: string) => {
      if (waiter.isWaiting(taskId)) return true;
      try {
        await stat(join(FARM_ROOT, "status", `${taskId}.consumed`));
        return true;
      } catch {
        return false;
      }
    },
  });

  // msg（票 04）：depth-1 角色 agent 注册 msg 工具（fan-out 到 worker/其他 pane）
  // meeting=false：会议编排只在 main（depth-1 不开会）。
  registerMsgTool(pi, { store: deps.store, inbox: deps.inbox }, false);

  // farm_resume（审计收尾 A1）：depth-1 注册 farm_resume，仅可恢复本 owner 的 depth-2 worker
  registerResumeTool(pi, deps.store);

  // comm reader（票 03/04 的 buildSteerSink）：400ms pollInbox 轮询（steer + msg 送达）
  armPaneCommReader(pi, deps.store);
}

/**
 * 消息气泡渲染器共享 factory（票 04）：farm.steer / farm.msg.notice /
 * farm.msg.directive / farm.meeting 四个 customType 复用 steerBubbleLines
 * （来源+时间戳+内容）。结构型 renderer：零 pi-tui import，自折行防超宽撕裂。
 */
function registerBubbleRenderer(pi: ExtensionAPI, name: string): void {
  pi.registerMessageRenderer(name, (message: any, _opts: any, theme: any) => ({
    render: (width: number) => {
      const w = typeof width === "number" && width > 0 ? width : 80;
      const lines = steerBubbleLines(message, w);
      let head = lines[0] ?? "";
      try {
        head = theme.fg("customMessageLabel", head);
      } catch {
        // 保真降级：theme.fg 不存在/抛错时用纯文本
      }
      return [head, ...lines.slice(1)];
    },
    invalidate: () => {},
  }));
}

/** msg 工具执行（main + depth-1）：解析 from 身份后走 executeMsg 纯逻辑。
 *  meeting=true（main-only 装配）：directive 广播到 ≥2 显式角色 → 开轮/替换活跃轮
 *  （fan-out deliver 之前），供 armMainCommReader 收回复合成。 */
async function executeMsgTool(
  params: MsgToolParams,
  store: TaskStore,
  inbox: Inbox,
  meeting: boolean,
): Promise<unknown> {
  const ownTaskId = process.env["PI_AGENT_TEAMS_TASK_ID"] ?? "";
  let from = "main";
  if (ownTaskId !== "") {
    const presences = await readPresences(FARM_ROOT);
    const record = await store.readTask(ownTaskId);
    from = resolveMsgFrom(ownTaskId, presences, record);
  }
  // 会议广播判定（C9 收敛）：编排与投递共用同一过滤寻址（excludeDepthGE:2），
  // 编排邀请集 == 实际投递集；depthCap:2 随消息落盘供读侧兜底。
  const meetingBroadcast = meeting && isMeetingBroadcast(params.delivery, params.targets);
  // 会议编排（fan-out 之前）：开会触发判定 → 寻址 → 守卫 paneIds≥2 → openRound/supersede
  if (meetingBroadcast) {
    const presences = await readPresences(FARM_ROOT);
    const all = await store.scanTasks(null);
    const running = all.filter((t) => t.status === "running");
    const now = Date.now();
    const paneIds = resolveMeetingTargets(params.targets, presences, running, now);
    if (paneIds.length >= 2) {
      const prev = getActiveRound();
      setActiveRound(prev === null ? openRound(paneIds, now) : supersede(prev, paneIds, now));
    }
  }
  return executeMsg(
    params,
    {
      readPresences: () => readPresences(FARM_ROOT),
      scanTasks: (owner) => store.scanTasks(owner),
      deliver: (input) => inbox.deliver(input),
      from,
    },
    meetingBroadcast ? { excludeDepthGE: 2, depthCap: 2 } : undefined,
  );
}

function registerMsgTool(
  pi: ExtensionAPI,
  deps: { store: TaskStore; inbox: Inbox },
  meeting: boolean,
): void {
  pi.registerTool({
    name: "msg",
    label: "Message",
    description:
      "Send a message to other agents (point-to-point by role, broadcast via \"all\", or " +
      "to the main session via \"main\"). " +
      "delivery=notice shows a line without interrupting; delivery=directive triggers the " +
      "target's next turn. Resolves targets via presence (live panes), falling back to running " +
      "tasks. Returns 「已向 N 个 agent 发送」.",
    promptGuidelines: [
      "Use msg with targets=[\"all\"] to broadcast to every live agent; use a role name to reach all instances of that role.",
      "notice only displays (deliverAs followUp); directive triggers the recipient's next turn.",
      "Reply to the main session with targets=[\"main\"]",
    ],
    parameters: Type.Object({
      targets: Type.Array(Type.String({ description: "role name(s), \"all\", or \"main\"" })),
      delivery: StringEnum(["notice", "directive"]),
      content: Type.String({ description: "message content" }),
    }),
    async execute(_toolCallId: unknown, params: unknown) {
      return executeMsgTool(params as MsgToolParams, deps.store, deps.inbox, meeting);
    },
  });
}

/**
 * farm_resume 工具注册（票 08 起 main-only；审计收尾 A1 扩展到 depth-1）。
 * depth-1 角色 agent 同样注册：仅可恢复本 owner 派发的 depth-2 worker（owner 相同，
 * 符合单写者矩阵）；跨 owner 仍被 executeResume 拒绝。main 与 depth-1 共用本函数。
 */
function registerResumeTool(pi: ExtensionAPI, store: TaskStore): void {
  pi.registerTool({
    name: "farm_resume",
    label: "Resume Task",
    description:
      "Resume an ABORTED task from its last conversation (≤7d session GC window). " +
      "Only aborted tasks are resumable (failed/cancelled must be re-dispatched). " +
      "Returns 「已恢复任务 <taskId8>」; the task re-enters the queue at its position.",
    promptGuidelines: [
      "Only aborted tasks support resume; failed/cancelled are rejected with guidance to re-dispatch.",
      "If the session was GC'd (>7d), resume reports 「会话已被回收，无法恢复」.",
    ],
    parameters: Type.Object({
      taskId: Type.String({ description: "taskId returned by spawn_visible_agent (must be aborted)" }),
    }),
    async execute(_toolCallId: unknown, params: unknown) {
      return executeResume(params as ResumeToolParams, {
        readTask: (id) => store.readTask(id),
        scanTasks: (owner) => store.scanTasks(owner),
        writeTask: (r) => store.writeTask(r),
        findSessionId: (dir) => findSessionId(dir),
        owner: OWNER,
      });
    },
  });
}

// ── setWidget 主会话状态面板（票 07，F1 台账，main-only）───────────────────

/** 面板 recent N（BE#5：限显示行数，防 tasks 无界增长 → 读盘量线性上涨） */
const PANEL_RECENT_N = 50;
/** 面板刷新周期（1s 全量快照，非 400ms，防闪烁） */
const PANEL_REFRESH_MS = 1000;

/** 价目表缓存（票 05）：惰性读 pricing.json，失败/缺省回退 DEFAULT；零写回（用户外部编辑）。 */
let pricingCache: PricingTable | null = null;
/** 是否回退 DEFAULT 占位价（pricing.json 缺失/坏 JSON）；审计收尾 C8：面板据此显式告知。 */
let pricingPlaceholder = true;

function getPricingTable(): PricingTable {
  if (pricingCache !== null) return pricingCache;
  let table: PricingTable = DEFAULT_PRICING_TABLE;
  let placeholder = true;
  try {
    const parsed = parsePricingTable(readFileSync(join(GLOBAL_ROOT, "pricing.json"), "utf8"));
    if (parsed !== null) {
      table = parsed;
      placeholder = false;
    }
  } catch {
    // 缺文件 / 坏 JSON / 不可读 → 回退 DEFAULT（pricing.json 用户外部编辑，pi-agent-teams 永不写）
  }
  pricingCache = table;
  pricingPlaceholder = placeholder;
  return table;
}

/** 模块级句柄锚点（farm.ts active 先例：reload 先清后武装，防残留双 ticker） */
let panelHandle: ReturnType<typeof setInterval> | null = null;
/** 上一拍渲染行（刷新节流：数据变化才 setWidget） */
let lastPanelLines: string[] | null = null;
/** 单拍串行闩（1s tick + async I/O 可能重叠，防并发快照） */
let panelBusy = false;
/** 面板代际号（票 07 快速修复）：armPanelTicker 时 ++；refreshPanel 拍内记录 epoch，
 *  finally 仅当 epoch === panelEpoch 才复位 panelBusy——防旧会话 in-flight 快照跨
 *  shutdown/新 arm 后晚到，误清新会话新拍已置起的闩（后果良性，代际号成本低）。 */
let panelEpoch = 0;

/**
 * SDK ExtensionContext 最小面（票 07 快速修复）：替代 wirePanel 处理器 ctx:any。
 * 只声明本文件用到的 ctx.ui.setWidget 三参形状（key / content:string[] /
 * options.placement），使该调用获得编译期校验；ui 保留 null|undefined（RPC/print
 * 形态 setWidget 可能缺失，运行时守卫照旧）。全量 SDK 类型不引入：node-modules.d.ts
 * 已把 SDK 面声明为 any（边界定位），本文件不动它。type-only，运行时擦除。
 */
interface ExtensionContext {
  ui:
    | {
        setWidget(
          key: string,
          content: string[] | undefined,
          options?: { placement?: "aboveEditor" | "belowEditor" },
        ): void;
      }
    | null
    | undefined;
}

/** 读 recent N 任务的 usage sidecar → taskId→UsageSidecar map（纯读，单写者=wrapper）。 */
async function readUsageMap(tasks: readonly TaskRecord[]): Promise<Map<string, UsageSidecar>> {
  const map = new Map<string, UsageSidecar>();
  await Promise.all(tasks.map(async (task) => {
    try {
      const raw = await readFile(join(FARM_ROOT, "usage", `${task.taskId}.json`), "utf8");
      const usage: UsageSidecar | null = parseUsageSidecar(raw);
      if (usage !== null) map.set(task.taskId, usage);
    } catch {
      // 缺文件 / 坏 JSON / 形状非法 → 跳过（feed usage 列显 "—"）
    }
  }));
  return map;
}

/** 读 recent N 任务的 inbox 快照（按 paneId 去重，合并全部消息供 buildFeed 按 to 过滤）。 */
async function readInboxForTasks(tasks: readonly TaskRecord[]): Promise<InboxMessage[]> {
  const paneIds = new Set<string>();
  for (const task of tasks) {
    const paneId = task.payload?.spawn?.paneId ?? "";
    if (paneId !== "") paneIds.add(paneId);
  }
  const out: InboxMessage[] = [];
  await Promise.all([...paneIds].map(async (paneId) => {
    out.push(...(await readInboxSnapshot(FARM_ROOT, paneId)));
  }));
  return out;
}

/** 单拍全量快照 → buildFeed → 数据变化才 setWidget（面板只读，零写回）。 */
async function refreshPanel(store: TaskStore, setWidget: (lines: string[]) => void): Promise<void> {
  if (panelBusy) return;
  panelBusy = true;
  const epoch = panelEpoch;   // 拍内代际快照（票 07 快速修复）
  try {
    const now = Date.now();
    const tasks = await store.scanTasks(null);          // 全量（计数行需总数，台账口径）
    const presences = await readPresences(FARM_ROOT);
    // sidecar / inbox I/O 只读 recent N（BE#5：不在 scanTasks(null) 之外再叠加线性读盘）
    const sorted = sortTasksForDisplay(tasks);
    const shown = PANEL_RECENT_N > 0 && sorted.length > PANEL_RECENT_N ? sorted.slice(-PANEL_RECENT_N) : sorted;
    const usageMap = await readUsageMap(shown);
    const inboxSnapshot = await readInboxForTasks(shown);
    const lines = buildFeed(tasks, presences, inboxSnapshot, usageMap, { now, recentN: PANEL_RECENT_N, pricing: getPricingTable() });
    if (pricingPlaceholder) {
      lines.push("⚠️ 成本为占位价：请编辑 ~/.pi-agent-teams/pricing.json 校准（缺文件/坏 JSON 时回退默认价）");
    }
    if (panelChanged(lastPanelLines, lines)) {
      setWidget(lines);
      lastPanelLines = lines;
    }
  } catch {
    // 单拍失败不崩 ticker（下一拍自然重试）
  } finally {
    // 仅本代拍复位闩：旧会话 in-flight 拍晚于新 arm 到 finally 时不得误清新拍闩
    if (epoch === panelEpoch) {
      panelBusy = false;
    }
  }
}

/** 面板武装（session_start）：先清后武装 + 首拍立即刷。 */
function armPanelTicker(store: TaskStore, setWidget: (lines: string[]) => void): void {
  if (panelHandle !== null) clearInterval(panelHandle);
  lastPanelLines = null;   // 新会话首拍必刷
  panelBusy = false;
  panelEpoch++;            // 代际 +1：旧会话 in-flight 快照的 finally 不再复位本代闩（票 07）
  const tick = () => void refreshPanel(store, setWidget);
  panelHandle = setInterval(tick, PANEL_REFRESH_MS);
  tick();                  // 首拍立即刷，不等 1s
}

/** 面板生命周期接线（main-only）：session_start 武装 / session_shutdown 清理。 */
function wirePanel(pi: ExtensionAPI, store: TaskStore): void {
  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    if (isPaneMode(process.env)) return;               // 守卫①：pane 侧实例永不注册
    const ui = ctx.ui;                                  // 守卫②：ctx.ui.setWidget 存在才调
    if (ui === null || ui === undefined || typeof ui.setWidget !== "function") return; // RPC/print 形态 no-op
    armPanelTicker(store, (lines) => ui.setWidget("pi-agent-teams", lines, { placement: "aboveEditor" }));
  });
  pi.on("session_shutdown", () => {
    if (panelHandle !== null) {
      clearInterval(panelHandle);
      panelHandle = null;
    }
    lastPanelLines = null;   // 复位：下次 session_start 首拍必刷
    panelBusy = false;
  });
}

// ── 装配（默认导出）─────────────────────────────────────────────────────────

export default function piAgentTeamsExtension(pi: ExtensionAPI): void {
  ensureFarmAssets();
  void runStartupProbe(pi);

  const display = new DisplayClient();
  const store = new TaskStore(FARM_ROOT);
  const inbox = new Inbox(FARM_ROOT); // 写侧投递器（main 单写者；pane 不写）
  const agentRoles = listAgentRoles(() => readdirSync(AGENTS_DIR));
  const paneMode = isPaneMode(process.env);
  const ownDepthValue = ownDepth(process.env);

  // farm.steer / farm.msg.notice / farm.msg.directive / farm.meeting 渲染器：无条件注册
  // （main 收不到 steer/msg 恒不触发；depth-1 需要气泡；farm.meeting 归 main 汇总气泡）——
  // 票 04 起共享 factory
  registerBubbleRenderer(pi, "farm.steer");
  registerBubbleRenderer(pi, "farm.msg.notice");
  registerBubbleRenderer(pi, "farm.msg.directive");
  registerBubbleRenderer(pi, "farm.meeting");

  // ⚠️ BE#3：presence 写者接线在 pane 判定/ownDepth return 之前（depth-1 真实注册；
  //   depth-2 若意外加载扩展也防御性注册——见 wirePanePresence）
  if (paneMode) wirePanePresence(store, ownDepthValue);

  // depth-2 worker（FE#3）：零 farm 工具，提前 return（无 spawn 无 wireFarm，收信归渲染器）
  if (paneMode && ownDepthValue >= 2) return;

  // farm_status：main + depth-1 注册（只读；depth-2 零工具不注册）——现形不变
  pi.registerTool({
    name: "farm_status",
    label: "Farm Status",
    description:
      "Show the farm task list or a single task's detail. No args = 5-column table " +
      "(taskId 前 8 位/role/status/attempts/耗时; sessions are kept 7 days). " +
      "Pass status to filter by one of queued/running/timeout/done/aborted/failed/cancelled. " +
      "Pass taskId (from spawn_visible_agent) for detail: full taskId/role/status/attempts/" +
      "nextAttemptAt/恢复命令/耗时.",
    promptGuidelines: [
      "Use farm_status to check farm task progress, queue position, or a task's resume command.",
      "Use farm_status <taskId> for detail when a spawn_visible_agent taskId needs inspection.",
    ],
    parameters: Type.Object({
      status: Type.Optional(StringEnum(FARM_STATUS_VALUES as unknown as readonly [string, ...string[]])),
      taskId: Type.Optional(Type.String({ description: "taskId returned by spawn_visible_agent (detail view)" })),
    }),
    async execute(_toolCallId: unknown, params: unknown) {
      return executeFarmStatus(params as { status?: string; taskId?: string }, { store });
    },
  });

  // depth-1 角色 agent：武装 mini-farm
  if (paneMode) {
    assembleMiniFarm(pi, { display, store, agentRoles, inbox });
    return;
  }

  // ── main-only（现形不变，仅 queue 构造点对齐）──
  // L2 启动警告（PRD §8.9「启动警告 + spawn 拒绝」）：非 WezTerm 环境（如 iTerm2）
  // 加载时即提示，不必等到 spawn 才撞门。pane 内实例在 WezTerm 中，此分支不可达。
  if (isL2Env(process.env)) {
    console.warn(
      "⚠️ pi-agent-teams：未检测到 WezTerm 环境（TERM_PROGRAM=WezTerm / WEZTERM_UNIX_SOCKET 缺失），" +
        "spawn_visible_agent 将拒绝派发（L2 降级）。请在 WezTerm 中运行 pi，或改用内置 subagent 工具（同步等待结果）。",
    );
  }
  const queue = new Queue({
    store,
    executor: makeExecutor(display),
    maxConcurrency: MAX_CONCURRENCY,
    owner: OWNER,
  });
  // 票 02/05：sync 等待器（main 的 spawn sync:true 用；isConsumed 供 wireFarm 去重）
  const waiter = createWaiter({ store, farmRoot: FARM_ROOT });

  pi.registerTool({
    name: "spawn_visible_agent",
    label: "Spawn Visible Agent",
    description:
      "Spawn a subagent in a NEW WezTerm pane (split to the right) with LIVE output, so the user " +
      "can watch the main session and the subagent's progress simultaneously. The tool returns " +
      "IMMEDIATELY with a taskId (no blocking wait; when the queue is full it reports 「已排队，位置 N」). " +
      "The task runs in its own pane and auto-closes when finished. Optional form: 'tui' (default) " +
      "= interactive pi TUI; 'worker' = status-window form (pane 内 ANSI 看板 + 背后无头 agent；" +
      "M2.5 由 main 显式传，M3 起 depth≥2 自动). " +
      "Results arrive as a farm.done notification (taskId/role/status/耗时/exitCode) — NEVER fabricate " +
      "or assume the task's result before the farm.done notification arrives. " +
      "Pass sync:true to block until the task finishes and return its result (spawn-and-wait; " +
      "default false = async, zero behavior change). Sync assumes low queue occupancy; for long " +
      "tasks (>30s) prefer async + farm_status / farm.done. While waiting, no other tool can be called " +
      "(the turn is suspended) — for mid-task steering use async mode + steer. " +
      "If you need the result synchronously, sync:true is the visible-pane option; the built-in " +
      "subagent tool remains for lightweight in-process work. " +
      "Optional agent persona: resolved from ~/.pi/agent/agents/<name>.md" +
      (agentRoles.length > 0 ? ` (available: ${agentRoles.join(", ")})` : " (currently none available)") +
      ". Check progress anytime with farm_status <taskId>.",
    promptGuidelines: [
      "Use spawn_visible_agent when you need a subagent — the user wants ALL subagents visible in split panes.",
      "spawn_visible_agent returns a taskId immediately; results arrive as a farm.done notification. Never fabricate or assume the task's result before that notification arrives.",
      "Use the built-in subagent tool instead of spawn_visible_agent when you need the result synchronously.",
      "Pass agent as one of the enumerated persona names; other names are rejected.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task prompt for the subagent" }),
      agent:
        agentRoles.length > 0
          ? Type.Optional(StringEnum(agentRoles as unknown as readonly [string, ...string[]]))
          : Type.Optional(
              Type.String({
                description:
                  "Agent persona name. 当前无人设可用：请在 ~/.pi/agent/agents/<name>.md 放置人设文件后 /reload。",
              }),
            ),
      cwd: Type.Optional(Type.String({ description: "Working directory for the subagent; default: current directory" })),
      timeout_secs: Type.Optional(
        Type.Integer({ minimum: 1, description: "Per-attempt timeout seconds; on timeout the task retries with backoff (default 600)" }),
      ),
      form: Type.Optional(StringEnum(["tui", "worker"])),
      sync: Type.Optional(Type.Boolean({ description: "true = 阻塞至任务终态并返回结果（spawn-and-wait）；缺省 false = 异步立即返回 taskId。同步等待假定低队列占用，满载时建议用异步 + farm_status。等待期间不可调其他工具（回合挂起）" })),
      wait_timeout_secs: Type.Optional(
        Type.Integer({ minimum: 1, description: "sync 等待超时秒数（缺省 120，上限 600；含排队时长）" }),
      ),
    }),
    // v2 会话恢复兼容：v2 的 title/destroy_delay_secs 在 v3 无对应语义（标题派生自
    // role+prompt、wrapper 无 countdown），剥离避免旧参数卡死 schema 校验。
    prepareArguments(args: unknown) {
      if (args === null || typeof args !== "object") return args;
      const { title: _title, destroy_delay_secs: _delay, ...rest } = args as Record<string, unknown>;
      return rest;
    },
    async execute(_toolCallId: unknown, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) {
      return executeSpawn(
        params as SpawnToolInput,
        ctx as { cwd?: string },
        { display, store, waiter, farmRoot: FARM_ROOT },
        signal as AbortSignal,
        onUpdate as ToolOnUpdate,
      );
    },
  });

  // FR8 按需启用：capability probe steer 能力 = typeof pi.sendMessage === "function"
  // （probe.ts runProbe 内 caps.steer 同款表达式，同步可得，不读 config.json）。
  if (typeof pi.sendMessage === "function") {
    pi.registerTool({
      name: "steer",
      label: "Steer",
      description:
        "Send a steer directive to a RUNNING role agent (spawn_visible_agent taskId). " +
        "Delivered after the target's current tool finishes, then triggers its next turn. " +
        "Only RUNNING tasks are accepted (queued/terminal rejected).",
      promptGuidelines: [
        "Use farm_status <taskId> to verify the target is running before steering; queued/terminal tasks are rejected.",
        "steer takes effect after the target's current tool finishes, then triggers a new turn.",
      ],
      parameters: Type.Object({
        targetTaskId: Type.String({ description: "taskId returned by spawn_visible_agent (must be running)" }),
        content: Type.String({ description: "steer directive content" }),
      }),
      async execute(_toolCallId: unknown, params: unknown) {
        return executeSteer(params as SteerToolParams, {
          readTask: (id) => store.readTask(id),
          deliver: (input) => inbox.deliver(input),
        });
      },
    });
  }

  // msg（票 04）：main 也注册 msg 工具（广播/点对点；与 depth-1 同一 registerMsgTool）
  // meeting=true：directive 广播到 ≥2 显式角色开轮（armMainCommReader 收回复合成）。
  registerMsgTool(pi, { store, inbox }, true);

  // comm reader（票 03）：main 收件接线——400ms pollInbox 轮询 inbox/main
  // （meetingSink 记回复进活跃轮 + buildSteerSink 投进主会话）。
  armMainCommReader(pi);

  // farm_resume（票 08 → 审计收尾 A1）：main + depth-1 均注册（见 registerResumeTool）
  registerResumeTool(pi, store);

  // farm 循环装配（票 05）：400ms ticker + 3s pane 探测 + 聚合通知（farm.done
  // followUp + triggerTurn:true）+ session_shutdown 全 kill（killSync）+ GC。
  wireFarm({
    queue,
    // display 适配层（修复轮）：farm 契约 listPanes(): string[]，04 实现返回
    // PaneInfo[]——此处过 adaptListPanes（display/adapt.ts，与测试同一来源）
    // 转 pane_id 字符串（缺失/空项剔除）。
    // spawn/kill/killSync 透传真实实现（farm 侧不调用 spawn/kill，仅
    // validateOptions 存在性校验；killSync 供 session_shutdown 全 kill）。
    display: {
      spawn: (cmd: string[], opts: { cwd?: string } = {}) => display.spawn(cmd, opts),
      listPanes: async () => adaptListPanes(await display.listPanes()),
      kill: (paneId: string) => display.kill(paneId),
      killSync: (paneId: string) => display.killSync(paneId),
    },
    pi,
    owner: OWNER,
    notify: async (message) => {
      pi.sendMessage(
        { customType: "farm.done", content: message.text, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
    farmRoot: FARM_ROOT,
    // 票 04（评审 R1②）：sync 已消费的终态不发 farm.done（共享 deliver 出口，flush+replay 双路径）
    isConsumed: async (taskId: string) => {
      if (waiter.isWaiting(taskId)) return true;
      try {
        await stat(join(FARM_ROOT, "status", `${taskId}.consumed`));
        return true;
      } catch {
        return false;
      }
    },
  });

  wirePanel(pi, store);   // 票 07：setWidget 主会话面板（1s ticker + shutdown 清理）
}
