# pi-agent-teams

pi-agent-teams 是一个 pi 扩展：让 agent 团队（agent teams）在终端分屏 pane 中以完整交互式 TUI 运行，并管理它们的任务生命周期。术语定义以 docs-internal/PRD-v3.md（§1-§13 项目计划书）为权威来源，本文是词汇快照。

## Language

### 核心实体

**Agent team（agent teams）**:
两层团队结构：main → 角色 agent（role agent）→ worker。层级分明、分工清晰；worker 不能再往下派。
_Avoid_: crew、层级编排

**Farm（农场）**:
一组同属一个工作区（workspace）的 agent pane（v3 中通常是一个终端窗口内的多个 tab）。
_Avoid_: 群组

**Workspace（工作区 / workspaceId）**:
由 pi 启动目录（cwd）经 realpath 归一化 + sha256 前 12 hex 派生的隔离单元（`src/workspace.ts`，C1 2026-08-26）。`FARM_ROOT = ~/.pi-agent-teams/<workspaceId>`（运行态目录 tasks/status/presence/inbox/sessions/usage/requests）；`GLOBAL_ROOT = ~/.pi-agent-teams` 存全局配置（pricing.json/config.json）。解析优先级：env `PI_AGENT_TEAMS_ROOT`（spawn 链显式传递）> cwd 派生 > cwd 空回退 home。不同项目目录进 pi cli 各归各的工作区，子代理列表/状态/消息互不可见。
_Avoid_: legacy 根（~/.pi-agent-teams 根下历史数据归档、不再读取）

**Main session（主会话）**:
运行 main agent 的那个 pi 会话/窗口——用户唯一对话入口，负责调度派发、接收摘要通知、向角色 agent 发 steer。main 是团队领导者，不是普通成员。
_Avoid_: orchestrator、控制台、lead

**Role agent（角色 agent）**:
由 main 按角色人设（~/.pi/agent/agents/*.md）派发的第二层 agent：完整 TUI、与 main 同等工具权限、身份平等；用户主要"看"它、偶尔直接对话；可派 worker。
_Avoid_: 子代理（泛指身份时；"子代理"仅指 pi 官方 subagent）

**Worker（worker）**:
配合角色 agent 干活的 agent（depth 2）：无 spawn 工具、不能再往下派。M2 起为完整 TUI（A 形态）；B 形态（自定义状态窗口，背后 pi -p 无头跑）已随 M2.5 交付（2026-08-14，六票 closed）。
_Avoid_: 临时工、子任务 agent

**Agent pane（agent pane）**:
运行一个角色 agent 或 worker 的交互式 TUI 分屏 pane。人类可直接打字观察——但直连对话是非主流用法，状态面板仅标记「被用户直连过」，不同步全文。是 pi-agent-teams 区别于黑盒 subagent 的核心载体。
_Avoid_: 窗口、终端、session（session 指会话记录）、子代理 pane（旧称）

**Meeting mode（开会模式）**:
需求讨论会——多角色同屏互发消息/广播。最小形态 = 广播议程 + 全体各回一回合 + main 汇总一回合；main 兼任主持；议程=广播文本，结论=main 汇总。
_Avoid_: 同步会议、圆桌（暗示复杂机制）

**Task（任务）**:
一次受 farm 管理的工作单元（派发/指挥/消息/调度四种类型之一），有 taskId、状态与生命周期。
_Avoid_: job（job 特指调度任务）、进程

**Schedule job（调度任务）**:
一个预约触发器：到点自动派发任务（一次性/间隔/cron）。它本身不是任务。
_Avoid_: 定时任务（与 Task 混淆）

**mini-farm（迷你农场）**:
depth-1 角色 agent 在 pane 侧武装的自己的农场（Queue owner=自身 + wireFarm + DisplayClient），用来派自己的 depth-2 worker。并发记账 `runningCount` 计**本 owner running**（per-farm 独立并发预算，不共享跨 owner 全局计数——评审整改 BE#1）。
_Avoid_: 子农场、二级农场

### 任务生命周期

**Task state（任务状态）**:
七态：queued → running → done / aborted / failed / timeout / cancelled（timeout/failed 可经 retry 回 queued，aborted 可经 resume 回 queued；完整迁移表见 PRD §13.3）。steer 投递态（pending→delivered→read）在 inbox 消息文件上推进，不进任务状态枚举。状态面板与队列按此汇报。
_Avoid_: pending、in-progress（用 queued/running）

**Steer（指挥）**:
对运行中角色 agent 的回合边界软干预：当前这轮工具调用全部执行完后投递。不是硬中断（官方无 kill API）。由 main 发给角色 agent；角色 agent 对 worker 的纠偏走消息通道（不在 steer 范围内）。
_Avoid_: 打断、中断、kill

**Resume（恢复）**:
让断掉的 agent 接着上次对话继续，而非从头开始。
_Avoid_: 重启、重跑

**Background mode（后台模式）**:
派发任务后立即返回 taskId、不阻塞主会话的模式；完成时主会话收到摘要通知（不塞全文）。
_Avoid_: 异步派发、fire-and-forget

**Form（形态）**:
spawn 任务的显示形态（payload.spawn.form）：`"tui"`（完整 TUI 角色 agent，缺省）或 `"worker"`（B 形态状态窗口：pane 内自研 ANSI 渲染器 + 背后 `pi -p --mode rpc` 无头跑）。与身份层级角色名 worker **正交**：form 是显示形态、role/层级是身份层级；M2.5 的 form:"worker" 任务 = main 直派 B 形态（depth 1），M3 恢复 depth-1 派发后 depth=2 任务强制 form:"worker"。
_Avoid_: 角色、层级（不同义）

**depth 分派（depth dispatch）**:
PI_AGENT_TEAMS_DEPTH 透传，depth = ownDepth+1（main=0 缺省）；depth≥2 强制 form:"worker"（B 形态，Queue 层不 rewrite）；depth-1 角色 agent 武装 mini-farm 派 depth-2 worker，depth-2 worker 零 farm 工具（收信归渲染器）。
_Avoid_: 层级派发（旧称）、递归派发

**farm_resume 工具（resume tool）**:
main-only 的 `farm_resume <taskId>`（owner-scoped）：仅 aborted 可 resume（failed/cancelled 拒绝），复用 `aborted × resume → queued` 迁移边，≤7d 窗口；depth-2 跨 owner resume 留 M4+。
_Avoid_: 重启、重跑（Resume 是概念，farm_resume 是工具）

**setWidget 面板（F1 台账）**:
主会话常驻状态面板（`ctx.ui.setWidget("pi-agent-teams", ...)`）：1s 全量快照刷新（`panelChanged` 纯函数节流，内容不变跳过），5 列台账 + 计数行 + live usage + 投递态只读。main-only（isPaneMode 守卫不注册）。
_Avoid_: dashboard、状态栏（含义过泛）

### 通信

**Inbox（收件箱）**:
每个 agent pane 的投递箱（角色 agent / worker 共用，无差异），steer/消息经此送达。
_Avoid_: 队列（与任务队列含义冲突）、信箱

**Broadcast（广播）**:
一条消息投递给所有 agent pane。开会模式复用为议程广播。
_Avoid_: 群发、fan-out

**Delivery mode（投递方式）**:
两种：notice（只显示不打断）与 directive（触发对方行动）。
_Avoid_: 消息类型（与 Task 的 type 字段混淆）

**comm（通信文件通道）**:
贯穿三层的共享文件通道（`src/comm/` 三模块）：`inbox.ts`（读侧轮询器）、`presence.ts`（心跳注册表）、`feed.ts`（面板聚合视图）。写侧复用 `task-core/steer.ts` 的 Inbox 类。TUI pane 侧扩展与 B 形态渲染器共用同一读侧模块。
_Avoid_: 消息总线、channel（易与操作系统概念混淆）

**presence（在线注册表）**:
每个 pane 侧进程每 3s 写 `presence/<taskId>.json` = {taskId,paneId,role,depth,pid,heartbeatAt}（tmp+mv，0600，写者=自身）。main 的 msg 工具用它做 role→paneId 映射；缺失时回退 scanTasks(null)。
_Avoid_: 在线表、心跳表（含义同，统称 presence）

**feed（面板聚合视图）**:
scanTasks + inbox 投递态 + usage 汇总成 setWidget 台账行（纯渲染零副作用）。缺省 recentN=50（BE#5：面板只渲染尾 50 行 + 计数行）。
_Avoid_: 面板渲染器、dashboard

**watermark（新鲜度 watermark）**:
读侧新鲜度判据 = 消息 `ts` > 本 inbox 目录内已 delivered/read 消息的最大 `ts`（磁盘现成、零新状态文件）；首读无 watermark 时才用 `mtime ≤ 60s` 兜底防陈旧文件。取代 M2 的 60s 墙钟年龄（B4 修订）。
_Avoid_: 新鲜度阈值、60s 年龄

**fan-out（写侧广播展开）**:
msg 工具的 `targets`（role|all）在**写侧**展开为 N 条 `to=<paneId>` 独立消息（每条独立 status 生命周期）。发送时快照：广播后新起的 agent 收不到。
_Avoid_: 广播（Broadcast 是结果语义，fan-out 是实现动作）

**at-most-once（投递语义）**:
comm 读侧投递保证：advance 到 delivered 在 sink 前、advance 到 read 在 sink 成功后；sink 抛错停留 delivered 不重投（本轮不崩循环），崩溃间隙由 24h GC 兜底。
_Avoid_: 恰好一次（明确是 at-most-once + GC 兜底，不承诺 exactly-once）

**steer 工具（steer tool）**:
main 注册的 `steer` 工具（targetTaskId + content 必填）：校验 status==running 后经 Inbox 投递 directive（到收信 pane）。纯逻辑落 `src/steer-tool.ts`；BE#7 已核验 `pi.sendMessage deliverAs:"steer"` + `registerMessageRenderer` 真实 SDK 形状。
_Avoid_: 指挥（Steer 是概念，steer 工具是实现）

**msg 工具（msg tool）**:
main + depth-1 角色 agent 注册的 `msg` 工具（targets=[role|all] + delivery=notice|directive）：写侧 fan-out 成 N 条 `to=<paneId>`。纯逻辑落 `src/steer-tool.ts`。
_Avoid_: 消息工具（与 Task type 字段混淆）

**steer-tool.ts（纯逻辑模块）**:
steer / msg / resume 三工具的纯逻辑共享文件（与 `probe.ts` 纯逻辑先例一致），零依赖可单测；不新建 per-tool 文件。
_Avoid_: 工具层（含义过泛）

### 环境与降级

**Capability probe（能力探测）**:
启动时探测 pi 能力与终端底座，按结果激活功能。（M3 票 01 起不再跑 `pi --help` 探测，resume/appendSystemPrompt 恒 true，只做廉价环境/API 检查）。
_Avoid_: 环境检测（太泛）

**Degradation level（降级级别）**:
L0（WezTerm 全能力）/ L1（mux 不可达，回退内置 subagent 并明示）/ L2（非 WezTerm 环境，启动警告 + 回退）。铁律：任务永不静默丢失。
_Avoid_: fallback mode（用 L0/L1/L2 表达）

**usage sidecar（用量侧写）**:
wrapper 从 session jsonl 提取用量写 `~/.pi-agent-teams/usage/<taskId>.json`（{model, inputTokens, outputTokens, updatedAt}）；Queue 在 done 时读之写回 task record `result.cost`（task 文件唯一写者不变）。TUI/worker 两形态统一来源（非渲染器 stdout）。
_Avoid_: 用量文件、cost 文件

**fixed input line（固定底部输入行）**:
B 形态渲染器输入行的 Bug#1 降级形态（spec backend#15）：`wireFixedInputLine` 绝对定位最底行 + 单行横向截断（≤cols 绝不折行），避免 readline 折行撕裂 prevRows。默认开启；`PI_RENDERER_FIXED_INPUT=0` 才回旧 readline 路径。
_Avoid_: 固定输入框（避免与 UI 控件混淆）
