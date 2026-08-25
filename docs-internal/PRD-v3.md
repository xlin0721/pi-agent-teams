# pi-agent-teams v3 项目计划（PRD）

> 版本：v0.5（身份模型变更：两层 agent teams）· 日期：2026-08-13 · 状态：**已审查拍板（§10 问题已答），待 M1b 开工**
> 本文档是唯一项目计划书：做什么（§1-§5）、里程碑与状态（§7）、验收（§8）、风险（§9/§13.8）、开发环境与工作流（§12）、技术设计（§13）。历史文档移出工作区，需要时从 git 历史 / tar 快照（~/pi-farm-docs-backup-*.tar.gz）/ 旧仓库 CLAUDE-taolun/test-pi/pi-farm 查看。

---

## 1. 一句话概括

**把 pi-agent-teams 从"派一个可见子代理"升级为"一个可见的 agent teams 工作台"。**

现在（v2）：你让主 agent 派一个子代理 → 右侧分屏弹出窗口 → 干完自动关窗汇报。**只有这一种模式**：派完干等，不能指挥、不能排队、不能恢复。

v3 目标：main 会话统一指挥，按角色派发**角色 agent**（完整 TUI、与 main 同等工具权限、可对话可指挥），角色 agent 再带 **worker** 配合干活（worker 不能再派）；多个 agent **排队干活、可随时 steer、任务断了能恢复、可互相发消息、可开会**。核心前提不变：**每个 agent 依然分屏可见可交互**（这是 pi-agent-teams 区别于一切社区项目的地方）。

**终端底座（v0.2 决议）**：锁定 **WezTerm 单目标**（macOS），彻底放弃 iTerm2。分屏/开窗/输写全部经 wezterm cli；v2 的 AppleScript+iTerm2 display 层代码留历史（M2 起重写）。环境异常按 FR9 三级降级链（L0/L1/L2，见 §4.9）处理。

---

## 2. 背景：为什么要做（3 句话）

1. 你从 Claude Code 切到 pi：CC 有完整的 subagents/agent teams，pi 只有最基础的 subagent 工具（派出去、干等、拿结果）。
2. 你自研了 pi-agent-teams 解决"看不见"：社区项目（pi-subagents 管任务、pi-messenger 管通信）都只能在主界面里看列表/后台跑，**只有 pi-agent-teams 给每个子代理一个完整的、可打字的真窗口**。
3. 结论：把社区项目已验证的"任务管理"能力（队列/指挥/恢复/调度）**参考设计、自己实现**，装进 pi-agent-teams，让它成为"看得见 + 管得住"的完全体。

---

## 3. 目标场景（6 个；A-D 已确认，E/F 为 v0.5 新增）

| # | 场景 | 一句话 |
|---|---|---|
| A | **后台并行 + 中途指挥** | 同时派 3 个角色 agent 干活，我不用等；看到哪个跑偏了，直接"喊话"纠正它 |
| B | **恢复 + 排队** | 任务断了/窗口关了能接着干；任务多了自动排队，不用我操心并发 |
| C | **角色 agent 间通信** | 角色 agent A 可以给 B 发消息（含"广播"：一句话发给所有 agent） |
| D | **定时调度** | 预约任务（如"明天 3 点跑一次"），到点自动派活 |
| E | **需求讨论会** | 把角色 agent 叫进"会议室"：多角色同屏互发消息/广播，像真实公司开会（最小形态：议程广播 + 各回一回合 + main 汇总） |
| F | **开发分工** | 主管领活派 worker：main 派前端/后端主管 → 主管派 worker 配合干活，层级分明 |

---

## 4. 功能需求（FR）

### 4.1 后台并行 + 角色派发（FR1）
- 派角色 agent 时可以选"后台模式"：立即返回任务 ID，不阻塞主会话
- 派发带角色人设：spawn 时指定角色（前端主管/后端主管/技术主管/产品经理等），从 ~/.pi/agent/agents/*.md 枚举；角色 agent 以人设 body（--append-system-prompt 注入）启动
- 层级封顶：main 派角色 agent（depth 1）→ 角色 agent 派 worker（depth 2）→ worker 无 spawn 工具不能再派；main 是唯一调度入口
- 任务完成后，主会话收到一条**摘要通知**（不塞全文，防止上下文膨胀）
- 随时可查所有 agent 的状态列表

### 4.2 队列与并发控制（FR2）
- 同时真正在跑的窗口数有上限（默认 3，可配置），超出自动排队
- 任务失败可重试；有超时机制
- 排队状态对用户可见（状态面板）

### 4.3 中途指挥 steer（FR3）
- main 给运行中的某个**角色 agent**发指令（单向：main → role agent），它**当前这轮工具跑完后**接收并执行（官方 API 的固有语义，spike 已验证）
- 指令在角色 agent 窗口里**带来源标注**显示（"来自 main"），与用户自己打字区分
- 角色 agent 对 worker 的纠偏复用消息通道（FR5），不走 steer
- 局限（已拍板接受）：无法硬中断正在执行的长工具，只能等它跑完这轮——官方无 kill API，已计划向 pi 上游提需求

### 4.4 恢复 resume（FR4）
- 任务中断后（窗口被关/超时/崩溃），可以**接着上次的对话继续**（spike 已验证官方支持）；resume 窗口 = session GC 7d 内，仅 aborted 可 resume（failed=spawn 用尽无会话可续、cancelled=用户主动取消，均不支持 resume）
- 恢复时能看到之前的完整对话上下文

### 4.5 pane 间通信（FR5）
- 角色 agent 之间（含 worker 收信）**对等**点对点发消息；支持广播（发给所有存活 agent，main 也可发）
- 两种投递：notice（只显示不打断）/ directive（触发对方行动）
- 开会模式（最小形态，M4 剩余）：广播=议程，各角色 agent 各回一回合，main 汇总一回合；main 兼任主持；零新增机制（复用广播 + 并行 pane + 状态面板）——「零新增机制」口径（M4 立项拍板）：零新增工具 / 零新增 schema / 零新增 pane 与进程；允许新增装配接线（main 收件 reader，复用 pollInbox）+ 内存态主持状态机（邀请名单 + from 计数 + 超时弃权，不落盘重启即失）
- 不做文件强预留（锁不住窗口里的真人，只做提示）

### 4.6 定时调度（FR6）
- 三种形式：一次性（one-shot）、间隔（interval）、cron 表达式
- 两阶段实现（已拍板）：先做"会话级"（pi 开着才触发，没开就静默失效并明示）；后做"launchd 级"（pi 不常驻也到点跑，借 macOS 系统定时器，不自己写 daemon）

### 4.7 状态面板（FR7）
- 主界面显示所有 agent 的状态（排队中/运行中/已完成/失败）+ 事后成本估算（官方已移除实时成本数据，只能事后统计）
- 角色 agent 窗口被用户直接对话过 → 状态面板仅标记「被用户直连过」，不回传全文（直连是非主流用法，窗口仍完整可交互）

### 4.8 运行时模块开关（FR8）
- 默认 5 工具常开（spawn_visible_agent / steer / msg / farm_resume / farm_status），capability probe 门仅 gate steer；无用户级动态开关（M3 拍板：工具爆炸防护由「数量恒定 5」承载，不补 registerFlag）
- 目的：不给模型塞一堆工具导致它选择混乱（工具爆炸防护）

### 4.9 环境探测与降级（FR9）

- **capability probe（pi 版本能力探测）**：启动时探测 pi 能力（steer / setActiveTools / --session 恢复等），按能力激活功能（与 FR8 运行时开关取交集）。
- **终端底座探测 + 三级降级链（已拍板）**：
  - **L0 正常**：`wezterm cli --no-auto-start list` 成功 → 全能力可用
  - **L1 mux 不可达**（GUI/mux 连不上、stale socket 等）：明示报错 + 回退 pi 内置 subagent 工具；文案必须注明影响为**全 mux 级**（同窗口所有 tab 均受影响）
  - **L2 非 WezTerm 环境**（如 iTerm2、终端.app）：启动警告 + 回退 pi 内置 subagent 工具
- **两条铁律**：任务永不静默丢失；探测命令必须带 `--no-auto-start`（不带会在 socket 失效时尝试拉起 mux server，产生副作用——spike 实测，结论见 §12.2）。
- **注（工具归属事实）**：v2 的 spawn_visible_agent 是 pi-agent-teams 自身注册的扩展工具（非 pi 内核，grep 实证）；M2 卸载/替换 v2 扩展。对上游建议改述为"pi 内置跨终端 visible-agent 工具"（新功能提议，与 interrupt API 的 FR 并存）。

### 4.10 原有 v3 路线图（并入，不丢）
- 窗口模型（已拍板）：单窗口 + tab + split-pane；多农场 = 多 tab 为**远期路线图**（非 M7 范围——M7 锁单窗口单 farm）；M7 网格 = tab 内 pane 排列（split-pane `--pane-id` 分裂「最大 pane」+ `--percent` 50，落点算法落盘 src/display/grid.ts）
- 网格实现口径（M7 收口，spike 定案）：`--top-level` 已否定（tab 根分裂、新 pane 占整半、旧内容整体挤压、越新越大，与平衡相悖）；实际落点用 `--pane-id` 定向分裂「最大 pane」（main 恒占 ~50%，farm pane 在另一半递归二等分）；类型预留 `topLevel` 字段保留，未来换策略仅改 grid.ts 单点
- 网格布局（多个窗口整齐排列）、多农场（多组窗口）、Tab 状态栏

---

## 5. 非目标（明确不做）

| 不做 | 理由 |
|---|---|
| crew 层级编排（三层及以上、角色间从属、自动扩编） | 与"两层 agent teams"冲突：crew 限定两层 main→角色 agent→worker；三层及以上、角色间从属、自动扩编出局 |
| 通用事件总线/pubsub 基建 | pi 已有官方机制，重造无价值 |
| 无头（headless）子代理作为交付形态 | 与"可见"核心矛盾；B 形态例外：worker 状态窗口 pane 内跑自研 ANSI 渲染器（可见），仅背后 agent 用 `pi -p --mode rpc` 无头跑（M2.5） |
| 跨平台 / 跨终端（Windows/Linux 终端；macOS 上非 WezTerm 终端如 iTerm2） | 底座锁定 WezTerm 单目标（macOS）；v2 的 iTerm2+AppleScript 代码留历史，不做双终端适配层 |
| 实时成本监控 | 官方数据源已断裂（issue #7911） |
| 跟随社区项目高频更新节奏 | 保持 pi-agent-teams 稳定优先 |

---

## 6. 模块划分（解答"task-core 是干嘛的"）

**房子类比**：把 pi-agent-teams 想成一栋房子，v3 要加两个新房间，但地基要重打。

```
pi-agent-teams 扩展（单仓库，一个目录，不拆包）
│
├── display 层（v2 代码留历史，M2 起用 wezterm cli 重写）── 窗户工程：负责"怎么在 WezTerm 分屏、pane 何时开何时关"
│
├── task-core 层（新写）── 项目总管：负责"派哪个任务、排队顺序、任务处于什么状态、
│                          何时算完成/失败/超时、指挥和恢复的规则"
│                          ★ 纯逻辑，不含任何 wezterm cli/界面代码，可以独立测试
│
├── comm 层（新写）── 对讲机：负责"主会话和角色 agent 之间、角色 agent 相互之间（含 worker）怎么传话"
│
└── 运行时开关 ── 电闸：需要哪个模块开哪个，防止模型负担过重
```

**task-core 通俗解释**：它不是一个"功能"，是**后台的规则大脑**。用户看不到它，但它决定：3 个窗口满了第 4 个任务怎么办（排队）、任务什么状态算完成、指挥消息怎么排队投递、恢复时从哪个对话继续。**没有它，FR1-FR6 全部无法实现；有了它，上面的功能只是"接上窗户和对讲机"而已。**

为什么先做它：spike（M1a 4 项实测 + M1a′ WezTerm 复测）证明官方 API 都支持，现在把规则写对、用单元测试锁住，后面每加一个功能都建立在可靠的地基上。

---

## 7. 里程碑（每个做完，你都能"摸到"东西）

| 里程碑 | 做完后你能看到什么 | 状态 |
|---|---|---|
| M0 设计对表 | 本文件 §13 技术设计（原 DESIGN-v3 并入）+ 本 PRD | ✅ 完成 |
| M1a 立论 spike | 4 项官方能力实测报告（steer 可用/恢复可用/开关工具可用/pane 内扩展可用） | ✅ 完成 |
| M1a′ 底座复测（WezTerm） | WezTerm 实机复测：split-pane/send-text/kill-pane/list 原语全绿；pane 内扩展加载双样本通过（-e 显式 + 裸 pi 全局发现）；setActiveTools 复测 9→8→9；wezterm cli 能力清单与 --no-auto-start 副作用实测落档 SPIKE-M1 证据（结论收于 §12.2） | ✅ 完成（2026-08-12） |
| **M1b task-core** | 看不见的地基：状态机 + 队列 + 调度规则 + 单元测试（135/135 单测绿、零依赖验收通过；实现记录见 .scratch/m1b-task-core/） | ✅ 完成（2026-08-13） |
| M2 后台模式 | 能派一个后台角色 agent（带人设）不干等，完成自动通知，能看状态列表（display 层 wezterm cli 重写） | ✅ 完成（2026-08-13）：task-core 补丁/display/farm/工具注册/wrapper 八票全 closed，301/301 单测绿；smoke 5 案全绿（派发/done/farm.done/自动关窗/人设、并发≤3、paneId 唯一、aborted+通知、SIGTERM→cancelled 收敛、L1 零落盘）；v2 已删、v3 已部署、主会话已重启切换、重启后实机验证通过（spawn 右分屏/farm_status/done 通知/自动关窗） |
| M2.5 B 形态（worker 状态窗口） | worker 以自定义状态窗口运行：pane 内跑自研迷你 ANSI 渲染器（任务状态/关键输出/进度/收 steer），背后 agent 用 `pi -p --mode rpc` 无头跑（stdin 行协议 prompt/steer，T0 spike 定案 A2）；无头 SDK 路径已验证（§12.2）、外部 transport 已定案（spike-facts-m25） | ✅ 完成（2026-08-14）：六票全 closed（01 spike / 02 PRD / 03 工程门 / 04 渲染器 / 05 steer 输入行 / 06 wrapper+smoke）；验证 385/385 测试 + tsc 零错 + grep 白名单 3a/3a'/3b/3c/3d + bash -n + farm.ts 零 diff；票 04/05/06 双评审过（reviewer 五维 + tech-director 六维）；实机 smoke 全绿（B 形态渲染/打字 steer/乐观徽标/ctrl+C 130/kill -9 137 pkill 收尸/TUI 回归 5 案全过） |
| M3 指挥 | 对运行中的角色 agent 喊话纠偏（steer）+ 角色 agent 间点对点/广播消息（msg）+ 任务恢复（resume）+ 主会话状态面板（setWidget） | ✅ 完成（2026-08-16）：10 票六层门控全过 + D 全链路 6 项实机 smoke 完成 + Bug A 修复并实机验证；513 测试全绿 + tsc 零错 |
| M4 通信 | 开会模式最小形态（议程广播 + 各回一回合 + main 汇总）——M3 已交 steer/msg/resume/面板，M4 剩余仅开会模式 | ✅ 完成（2026-08-16）：开会模式最小形态 10 票收口（MeetingHost 纯状态机 + main 收件接线 + 会议编排合成）+ 552 单测 + tsc 零错；smoke Case1/2/6 ✅，Case3 合成/4/5 被 reload 副作用阻塞（主会话完整重启复验） |
| M5 定时（会话级） | 能预约"5 分钟后跑一次"（pi 关了就失效） | |
| M6 定时（系统级） | pi 不常驻也能到点跑（launchd） | |
| M7 收尾 | 网格布局 + 成本面板 + 分发给同事实测 | ✅ 完成（2026-08-17）：网格落点算法（`--pane-id` 分裂最大 pane，落盘 grid.ts）+ 成本面板（pricing.ts + pricing.json + feed 成本列）+ 分发文档（docs-internal/DISTRIBUTION.md）；610 单测全绿 + tsc 零错 |

---

## 8. 验收标准（做成什么样算过）

1. **FR1**：派 3 个后台任务，主会话立即可继续对话；3 个窗口同时可见；完成各收到摘要
2. **FR2**：同时派 5 个，只有 3 个窗口在跑，2 个排队；状态面板显示排队中
3. **FR3**：给运行中的角色 agent 发"改用方案 B"，它这轮跑完后收到并调整方向；窗口里消息带"来自 main"标注
4. **FR4**：关掉一个窗口，重新打开能接着上次对话继续
5. **FR5**：角色 agent A 发消息给 B，B 窗口里出现；广播则所有窗口都出现
6. **FR6**：预约 1 分钟后跑，1 分钟后窗口自动弹出执行
7. **FR7**：状态面板实时反映各任务状态
8. **FR8**：默认 5 工具恒定（spawn_visible_agent / steer / msg / farm_resume / farm_status）
9. **FR9**：L1——使 mux 不可达（杀 GUI/mux 或指向失效 socket）后跑：spawn 拒绝执行 + 明示报错（文案注明同窗口所有 tab 受影响）并引导内置 subagent 工具（不自动路由），任务不落盘不静默丢失；L2——在非 WezTerm 环境（如 iTerm2）跑：启动警告 + spawn 拒绝并引导内置 subagent 工具，不崩溃
10. **回归**：v2 全部能力（派发/分屏/自动关闭/结果回传）在 WezTerm 底座上等价可用（M2 起 smoke-test 切 wezterm cli 后全绿）。**基线 = 部署版 v2.0.1 行为**（idle 5s / countdown 15s / GC 口径 requests 1h·status 24h·sessions 7d；工作区 git 快照 v2.0.0 仅历史，不再作基线）
11. **角色派发**：指定人设派发角色 agent，pane 内以该人设应答（抽查身份自述）；不传 --tools 时角色 agent 拥有全量工具；worker 无 spawn 工具、派发被拒（depth≥2）
12. **开会**：广播议程 → 各角色 agent 各回一回合 → main 汇总一回合；全程仅用 FR5 广播 + 并行 pane + 状态面板，无新机制（「无新机制」口径 = 零新工具/schema/pane；允许 main 收件装配 + 内存主持状态机）
13. **B 形态（M2.5）**：pane 内 ANSI 渲染器显示任务状态/关键输出/进度；`pi -p --mode rpc` 事件流驱动（message_end / tool_execution_end；**usage 无独立事件，从 message 字段提取**；message_update delta-only 按 contentIndex 组装 + message_end 权威校正）；steer 经无头通道（stdin 行协议）送达并触发新回合
14. **网格（M7）**：连 spawn 3 个 pane → main 保持 ~50%、farm pane 在另一半形成平衡网格（`--pane-id` 分裂最大 pane）；非 WezTerm 环境（L2）/ listPanes 失败 → 回退 `--right` 不阻断 spawn
15. **成本（M7）**：面板 usage 列显 `↑N ↓N $X`；done 任务金额正确；aborted 任务显 sidecar 成本；running 显「—」；未知模型显「—」；合计行正确；pricing.json 缺省/覆盖/非法回退生效

---

## 9. 风险（简要）

| 风险 | 应对 |
|---|---|
| 做大了收不住 | 范围纪律已写入 §5；每个里程碑独立可用，随时止损 |
| 官方 API 变化 | 启动探测 + 降级链（FR9） |
| 模型工具选择混乱 | FR8 开关 + 并发上限 |
| 上下文/成本膨胀 | 后台任务只回摘要，不塞全文 |
| 单元测试跑不了分屏链路 | task-core 纯逻辑可测；分屏链路保留本机 smoke-test |
| 身份/层级语义膨胀 | 两层封顶 + worker 无 spawn 工具；三层以上、角色间从属出局（§5）；开会锁定最小形态 |

---

## 10. 审查问题（已答，2026-08-13）

1. 4 个场景全要，无增删。✅
2. 同意；"跨平台"理由已按 v0.2 底座决议更新为"锁定 WezTerm 单目标"。✅
3. 已理解确认。✅
4. M2 先做"后台模式"，确认。✅
5. FR9 改三级降级链（L0/L1/L2）；回归措辞改"v2 能力在 WezTerm 底座上等价可用"。✅
6. 新工作区 = 本仓库根目录（迁移已完成：不带 .v1-bak；部署副本/运行时/spike 区不动）。✅

## 11. 文档地图（新会话从哪开始）

本文件是**唯一计划文档**（需求 + 设计 + 环境 + 工作流合一，§1-§13），新会话从头读到尾即可开工。
- **docs-internal/adr/**：不可逆决策记录（0001 WezTerm 单目标）
- **docs-internal/HANDOFF.md**：里程碑交接文档（当前阶段状态 + 下一会话开局步骤与开工清单）
- **docs-internal/迭代备忘录.md**：里程碑决策记录（范围/技术约束/延期挂账，M2 断点版已含）
- **CONTEXT.md**：领域词汇表；**AGENTS.md / docs-internal/agents/**：工程技能脚手架
- 历史文档（v2 设计/开发指南/版本记录/spike 证据）已移出工作区，需要时从 git 历史、tar 快照（~/pi-farm-docs-backup-*.tar.gz）或旧仓库 CLAUDE-taolun/test-pi/pi-farm 查看

---

## 12. 开发环境与工作流

### 12.1 环境事实

| 项 | 值 |
|---|---|
| pi 版本 | 0.84.1（/usr/local/bin/pi，node：/usr/local/bin/node） |
| 终端底座 | WezTerm（单目标，已放弃 iTerm2）；分屏/开窗经 wezterm cli；一切调用带 --no-auto-start |
| 源码仓库 | 本仓库根目录（开发改这里） |
| 部署副本 | ~/.pi/agent/extensions/pi-agent-teams/（只同步不开发） |
| 运行时目录 | ~/.pi-agent-teams/（requests/status/sessions/config.json/wrapper.sh） |
| spike 隔离区 | ~/.pi-farm-spike/（probe 扩展 + evidence，证据保留） |
| pi 官方文档 | /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/（extensions.md 是扩展 API 权威） |
| 全局扩展 | ~/.pi/agent/extensions/：subagent（官方🚫禁改）、github-tools、pi-agent-teams（v2，M2 卸载/替换） |

### 12.2 已验证结论（spike 实证，不要重复验证）

| 结论 | 影响 |
|---|---|
| ✅ pane 内交互 TUI 会加载全局扩展（WezTerm 双样本复测，扩展加载与终端无关） | steer/msg 的 pane 侧接收端可行 |
| ⚠️ pi -p 无头模式不加载全局扩展；-e <路径> 可显式加载 | M6 tick CLI 无需 farm 扩展 |
| ✅ steer = pi.sendMessage({customType, deliverAs:"steer", triggerTurn:true})：当前回合工具调用全部执行完后投递 | 回合边界软干预，无 kill API |
| ✅ pi.setActiveTools() 运行时开关生效（9→8→9 实测） | FR8 可行 |
| ⚠️ 恢复 = pi -p --session-dir <dir> --session <id>（必须带 --session）；id 从 jsonl 文件名 *_<uuid>.jsonl 解析 | FR4 resume 实现依据 |
| ⚠️ wezterm cli 裸调用在 mux 失效时会尝试拉起 mux server（副作用）→ 探测必须带 --no-auto-start | FR9 L1 判定依据 |
| ✅ 无头 steer 实测通过：pi -p -e <probe> 下 setActiveTools 无头可用、sendMessage steer 投递且 triggerTurn 触发新回合、无循环 | B 形态（M2.5）核心通道成立 |
| ⚠️ 无头审批行为未实测（-p 无 TUI 弹审批；--approve 在 -p 下行为存疑） | B 形态立项前补测 |
| ✅ **V10 补测（2026-08-13）**：pi 0.84.1 无工具级审批机制（bash/write 直接执行，事件流无 approval 类型，agent 不会卡住）；唯一「审批」= 项目信任（.pi/ 资源加载守卫），无头下不弹 UI，`--approve` 在 -p 下生效（语义=信任项目文件）；`-e` 扩展可编程决策 project_trust。B 形态 wrapper 应带 --approve 或自带 trust 决策扩展（防 farm scratch 目录 .pi/ 资源静默失效） | B 形态（M2.5） |
| ⚠️ get-text 回读保真度未实测 | B 形态立项前补测 |
| ✅ **V3 补测（2026-08-13）**：默认只回读可见屏；`--start-line <负数>` 拿全 scrollback（行号稳定，轮询可按行增量）；颜色需 `--escapes` 且为归一化 SGR；行尾 `\r`；超宽行按 pane 宽切 visual 行无 reflow 标记 | B 形态（M2.5） |
| ✅ **T0 steer transport spike（2026-08-13，定案 A2）**：`pi -p --mode rpc` + stdin 行协议胜出——初始任务 `{"type":"prompt"}` 注入、运行中 steer `{"type":"steer"}` → response + queue_update + 工具回合后自动新回合（行为被改变已实证）；A1（--mode json + stdin）结构性不通（readPipedStdin 阻塞到 EOF、stdin 内容拼进 prompt 污染初始任务）；B 案（comm 文件桥接）不需要。rpc stdout 无 session header、LF 合帧；agent_settled 后 steer 只入队不触发（输入行边缘改 prompt 注入）；queue_update 形状 `{steering:string[],followUp:string[]}`；watchdog done 判据形状（tail -1 含 stopReason:stop 无 toolCall）rpc+json 双模式实测 PASS；EPIPE/ERR_STREAM_DESTROYED 双形态样本；pi 被 TERM 自清工具子进程。样本：.scratch/m2.5-b-form/spike-facts-m25.md + evidence/m25-* | B 形态（M2.5）核心通道成立 |

### 12.3 技术约束（写代码前必读）

1. **task-core 是纯 Node 库**：只用 node 内置模块，零 import pi / iTerm2 / WezTerm / typebox / 任何非 node 内置模块（M1b grep 验收）。工具参数 schema 属于 index.ts 层。
2. **依赖方向**：task-core 只依赖注入的 Executor 接口（spawn/steer/kill），不 import display/comm；display 层 M2 起用 wezterm cli 重写。
3. **文件协议**（§13.3）：per-task 单文件 ~/.pi-agent-teams/tasks/<id>.json 为单一事实源；原子写 tmp+mv；复用 400ms 轮询，禁 fs.watch；拥有者进程写入。
4. **状态机 7 态**：queued/running/done/aborted/failed/timeout/cancelled；steer 投递态（pending→delivered→read）记录在 inbox 消息文件上推进，不进任务状态枚举（完整迁移表见 §13.3）。
5. **并发上限默认 3**（可配）；嵌套 depth≤2；任务级超时。
6. **安全校验**（steer/msg 文件）：同 uid + 0600 + 时间戳新鲜度 >60s 拒收；不做 HMAC（同用户信任边界）。
7. **膨胀防线**：单文件超 ~1000 行即拆；每里程碑独立可用。
8. **零第三方 npm 依赖**是硬约束（node 内置 + pi 自带能力）。

### 12.4 协作与工作流

- think-first 已收敛完成（含底座决议 WezTerm 单目标）：按里程碑直接开发；**需求变更（PRD 增删/验收改）才走协议**。
- **修改许可**：本仓库可改；部署副本只同步；官方 subagent / pi 本体 / 全局 ~/.pi/agent/AGENTS.md 禁改。
- **wezterm cli 子命令用前必查** `wezterm cli <子命令> --help`，禁止凭记忆（v1 的 P0 事故教训）。
- **流程**：改仓库 → 单测/验证 → 同步部署副本（cp + diff 三处校验）→ smoke-test → 更新本文件 §7 状态。wrapper.sh 改动必须三处一致（源码 assets / 部署副本 assets / ~/.pi-agent-teams/）。
- **阶段化推进**：每里程碑先对齐范围（§7 对应行）→ 开发/验证 → 更新 §7 状态；git 提交即版本记录。
- 身份模型 v0.5 = 两层 agent teams（main→角色 agent→worker，见 §13.1 D7-D9），已拍板。

### 12.5 当前进度与第一步

- ✅ 已完成：M0 设计对表；M1a 立论 spike；M1a′ WezTerm 底座复测；文档单文档化；**M1b task-core**（135/135）；**M2 后台模式**（八票全 closed，301/301 单测绿，smoke 5 案全绿，v3 已切换并实机验证）；**M2.5 B 形态**（六票全 closed，385/385 测试 + tsc + smoke 全绿，B 形态 + TUI 回归实机通过；详见 .scratch/m2.5-b-form/ 与 docs-internal/迭代备忘录.md「M2.5 收口」）
- **下一步：M4 通信**：开会模式最小形态（议程广播 + 各角色 agent 各回一回合 + main 汇总一回合，零新增机制——复用 FR5 广播 + 并行 pane + 状态面板）+ 6 项技术债（见 docs-internal/迭代备忘录.md「M3 D 全链路 smoke」节）。M4 开工前建议走 think-first 立项（开会模式属新需求）。

### 12.6 千万别做

- ❌ 改 ~/.pi/agent/extensions/subagent/（官方扩展）
- ❌ 改 pi 本体 node_modules
- ❌ 引入第三方 npm 依赖
- ❌ 凭记忆用 wezterm cli 子命令（先 --help）
- ❌ 在部署副本直接开发（会被同步覆盖）
- ❌ 把大段旧对话贴给用户（读文档）

---

## 13. 技术设计

### 13.1 决策记录

| 项 | 决策 |
|---|---|
| D1 范围 | abcd 全要：后台并行+steer / 恢复+排队 / pane 间通信 / 定时调度 |
| D2 路线 | 参考社区项目设计、核心能力自研、零第三方依赖 |
| D3 身份 | 显示层 + 任务管理层，进本体 |
| D4 底座 | WezTerm 单目标；display 层 M2 起用 wezterm cli 重写；FR9 三级降级链（L0/L1/L2）；L1 判定 = wezterm cli --no-auto-start list |
| D5 工具归属 | spawn_visible_agent 为 pi-agent-teams v2 自注册扩展工具（pi 内核 grep 零命中）；M2 卸载/替换 v2 扩展；上游建议改述为"建议 pi 内置跨终端 visible-agent 工具" |
| D6 验收 | M1b grep 验收：零 import pi / iTerm2 / WezTerm / typebox / 非 node 内置模块 |
| 模块化 | 不拆包、单仓库、单扩展分发；编译期三层 + 运行时积木开关 |
| 调度节奏 | 两阶段：会话内 ticker（明示降级）→ launchd pi-agent-teams tick CLI |
| steer 定位 | 回合边界软干预（官方无 kill API）+ 人工关 pane 兜底；向 pi 上游提 interrupt API feature request |
| D7 身份模型 | 两层 agent teams：main（唯一对话入口/调度派发/steer 来源）→ 角色 agent（完整 TUI、与 main 同等工具权限、身份平等、用户主要"看"）→ worker（配合角色 agent，不能再派）。用户平时只在 main 对话；对角色窗口直接对话是非主流用法（窗口仍完整可交互） |
| D8 人设机制 | 复用 pi 人设体系 ~/.pi/agent/agents/*.md：import pi 包 parseFrontmatter/getAgentDir/CONFIG_DIR_NAME（官方导出，官方 subagent 示例实证）→ body 写临时文件 → spawn pi 时 --append-system-prompt <tmp> + --name <角色名> + --session-dir；首版不传 --tools（角色 agent 拿全量工具，人设 tools 字段仅元数据保留，差异化权限以后加开关）；人设只在新建会话注入（resume 恢复原会话不重注入）。**角色 agent 自主发散权**（用户拍板 2026-08-13）：不注入执行纪律段、不加 think-first 豁免句——角色 agent 自行决定是否发散探索（其在 pane 内用内置 subagent 派发的子代理在农场视野外，属接受边界；M3 steer/msg 通道可再收紧） |
| D9 开会最小形态 | 广播 + 等全体各回一回合 + main 汇总一回合；纯复用 FR5 广播 + 并行 pane + 状态面板，零新增机制；main 兼任主持；议程=广播文本，结论=main 汇总。「零新增机制」口径（M4 立项拍板）= 零新工具/schema/pane，允许 main 收件装配（复用 pollInbox）+ 内存主持状态机（不落盘）。用户直连角色窗口不同步全文，状态面板仅标记「被用户直连过」 |

### 13.2 模块结构

```
index.ts            薄入口：注册工具/flag/渲染器，装配三层
farm.ts             编排：executor 绑定、队列循环、完成通知
steer-tool.ts       steer/msg/resume 三工具纯逻辑（A 侧执行 + B 侧 TUI sink + 寻址裁决 + 会议邀请集过滤；零 pi SDK）
probe.ts            纯逻辑：capability 探测 / 降级门 / 角色校验 / farm_status 渲染（零依赖）
pricing.ts          成本换算纯模块（token → 金额；零 I/O，被 feed.ts 消费）
display/            split.ts / protocol.ts / render-core.ts + render-mini.ts（B 形态 ANSI 渲染器，M2.5；纯函数+薄入口拆分）   ← M2 用 wezterm cli 重写；行为目标：v2 能力等价
task-core/          store.ts / states.ts / queue.ts / schedule.ts / steer.ts / resume.ts
                    纯逻辑，零 pi/iTerm2/WezTerm/typebox/非 node 内置模块依赖
comm/               inbox.ts（读侧轮询器）/ presence.ts（心跳注册表）/ feed.ts（面板聚合视图）/ meeting.ts（开会模式状态机）——文件通道，主侧 + pane 侧共用；写侧 Inbox 类留在 task-core/steer.ts（deliver/advance/pickLatest，已实现已测，零依赖）
assets/             wrapper.sh（env-only 契约 15 变量：PI_AGENT_TEAMS_TASK_ID/DONE_FILE/ABORT_FILE/SESS_DIR/TITLE/CWD/PI_AGENT_TEAMS_PANE=1/PERSONA_FILE/PI_BIN/PI_SCRIPT/PI_AGENT_TEAMS_FORM/PI_RENDERER/PI_AGENT_TEAMS_DEPTH/PI_AGENT_TEAMS_RESUME/PI_NODE；协议文件零改动）
```

- **运行时积木（FR8，M3 拍板）**：默认 5 工具常开（spawn_visible_agent / steer / msg / farm_resume / farm_status），capability probe 门仅 gate steer；无用户级动态开关（工具爆炸防护由「数量恒定 5」承载，不补 registerFlag）。spawn_visible_agent 为 v3 自注册同名工具；v2 同名工具随 M2 卸载 v2 扩展移除。
- **spawn 角色参数**：注册时从 getAgentDir() 枚举人设名写入 schema 说明（防模型瞎编角色名）；执行时校验不在枚举内的角色名一律拒绝并提示可用角色。
- **display 层（M2，wezterm cli）设计要点**：
  - spawn：split-pane --right [--cwd <dir>] -- <cmd>，stdout 即新 pane-id；多农场用 spawn（默认当前窗口新建 tab）；M7 网格 = spawn 落点算法（`--pane-id` 分裂「最大 pane」+ `--percent` 50，非 `--top-level`——`--top-level` 已在 spike 否定；落点算法落盘 grid.ts，display 纯原语 + 零 SDK 边界）
  - 输写：send-text --pane-id <id> --no-paste（仅人工应急，不进自动链路）
  - 窗口关闭探测：3s 间隔轮询 wezterm cli --no-auto-start list --format json 的 pane-id 集合（仅存在 running 任务时启停）；任务仍 running 而 pane-id 消失 → 经 Queue.step {paneGone} 注入 aborted（tick 注入，不落 status 文件——aborted 文件唯一写者=wrapper）；status/<id>.done|aborted 文件通道仍为主信号
  - Executor 接口：spawn/steer/kill 三方法，task-core 不感知终端；**spawn 签名扩展（M2）**：spawn(task) → Promise<{paneId, sessionDir}>，queue 写回 task record（探测映射唯一落盘处）
  - display 层为纯原语：spawn(cmd,cwd)→paneId / listPanes() / kill(paneId) / parseList（字段缺失容错）；探测循环/通知聚合/GC 归 farm.ts
  - 导航/布局：activate-pane / activate-tab / zoom-pane（窄屏缓解）/ set-tab-title / move-pane-to-new-tab；pane 级标题无 cli 原语（V4 待验证）
  - 探测纪律：一切 wezterm cli 调用必须带 --no-auto-start；pane 外调用默认寻 GUI、必要时 --prefer-mux（V7）
  - **B 形态（M2.5，worker 状态窗口）**：pane 内跑自研迷你 ANSI 渲染器（零第三方依赖），显示任务状态/关键输出/进度并收 steer；背后 agent = `pi -p --mode rpc --session-dir <S> --approve` 无头跑（**T0 spike 定案 A2**：初始任务 stdin `{"type":"prompt"}` 注入、运行中 steer stdin `{"type":"steer"}`——A1 json 模式结构性不通，stdin 阻塞到 EOF 且拼进 prompt）；渲染器消费 rpc stdout 事件流（**无 session header、LF 合帧**；message_end/tool_execution_end + message 字段内嵌 usage；message_update delta-only）；默认文本流无结构且混 stderr（实测含扩展告警，**stderr → /dev/null 必吞**）；steer 流中送达 → 工具回合后自动新回合（行为被改变已实证）；**agent_settled 后 steer 只入队不触发 → 输入行边缘改 prompt 注入**；watchdog done 判据形状双模式实测 PASS；pi 被 TERM 自清工具子进程（树杀双保险）。样本：.scratch/m2.5-b-form/spike-facts-m25.md
- **farm 循环生命周期（M2）**：队列循环与 ticker 由主会话扩展在 session_start 武装（setInterval 400ms → Queue.step，回调顶层 try/catch；ticker 句柄先清后武装）；session_shutdown 幂等销毁 + **spawnSync 全 kill 本会话 running pane + cancelled 落盘**（kill 不删 session 文件）；reload/新会话必须重新武装（捕获旧 pi 引用的定时器会触发官方 assertActive 异常）。完成通知 = pi.sendMessage({customType:"farm.done"}, {deliverAs:"followUp", triggerTurn:true})——会在主会话触发一个无人发问的新回合（主 agent 见通知后自行决定如何汇报）；**聚合器：每 step 收集终态事件，距上次 flush ≥2s 发 1 条**（done 摘要 = taskId+role+status+耗时+exitCode；aborted/cancelled 附恢复命令）；notifiedAt 落盘 + session_start 补发（**owner==本进程或 owner 进程已死** + 终态 + 未通知 + updatedAt≤24h，防双会话重复通知且跨重启补发成立）；**GC tick 顺带执行**（v2 口径：requests 1h/status 24h/sessions 7d/hb 24h/log 7d）；摘要不塞全文。pi 0.84.1 无 run_in_background 类非阻塞工具执行 API（已实证），后台 = 工具立即返回 taskId + 循环托管。

### 13.3 task 文件协议（M1b 核心）

布局：

```
~/.pi-agent-teams/
  tasks/<taskId>.json     per-task 单文件，单一事实源（拥有者进程写入）
  status/<taskId>.done    exit code + 会话文件路径
  status/<taskId>.aborted
  sessions/<taskId>/      pane 会话 JSONL（结果 + 成本数据源）
  inbox/<paneId>/<msgId>.json   steer/消息投递箱（pane 侧 400ms 轮询；to 恒为具体 paneId，all 由写侧 fan-out 展开，无 all/ 段）
  presence/<taskId>.json   心跳注册表（pane 侧每 3s 原子写；{taskId,paneId,role,depth,pid,heartbeatAt}）
  usage/<taskId>.json      usage sidecar（wrapper 从 session jsonl 提取；{model,inputTokens,outputTokens,updatedAt}）
  requests/<taskId>.agent-prompt   人设临时文件（stagePersona 落盘；GC 1h 回收）
  schedule/<jobId>.json   调度任务注册（PID 锁 + cron 解析）——⚠️ v3 零实现（M5/M6 已 defer，仅 schedule.ts 解析器预留，无 ticker）
```

task record 字段：

```json
{
  "taskId": "uuid", "type": "spawn|steer|msg|schedule",
  "parentId": "uuid|null", "depth": 1,
  "status": "queued|running|done|aborted|failed|timeout|cancelled",
  "owner": "pid+启动时间", "createdAt": 0, "updatedAt": 0,
  "startedAt": 0, "nextAttemptAt": 0, "notifiedAt": 0,
  "timeoutSecs": 0,
  "attempts": 0, "maxAttempts": 2, "backoffSecs": [5, 30],
  "payload": {
    "spawn":   { "role": "tech-director", "prompt": "", "cwd": "", "resumeFrom": "sessionId|null", "paneId": "", "form": "tui|worker" },
    "steer":   { "targetTaskId": "", "content": "" },
    "msg":     { "targets": ["role|all"], "delivery": "notice|directive", "content": "" },
    "schedule":{ "mode": "once|interval|cron", "cron": "", "intervalSecs": 0, "onceAt": 0,
                 "lastRun": 0, "nextRun": 0, "firedTaskIds": [] }
  },
  "result": { "sessionDir": "", "exitCode": null,
              "cost": { "model": "", "inputTokens": 0, "outputTokens": 0 } }
}
```

（steer/msg 直写 inbox、不落 task record、不走状态机 transition——task record 仅 spawn（及 M5 schedule）型任务走队列派发，`type` 枚举保留历史，无 type:"msg"/"steer" 任务级生命周期记录。）
（cost 只存 token 数与 model：task-core 纯 Node 无价目表；价格换算层 = src/pricing.ts（纯换算，零 I/O）+ ~/.pi-agent-teams/pricing.json（用户可配、pi-agent-teams 只读不写）——原「放 index.ts 层/事后统计」细化为 pricing.ts 模块。旧落盘记录字段缺失容错：startedAt/nextAttemptAt/notifiedAt 缺 = 0/未通知；存量记录缺 owner → 只读外务：farm_status 可见、queue 不迁移。）

inbox 消息 record：

```json
{
  "msgId": "uuid", "type": "steer|msg",
  "from": "main|paneId", "to": "paneId",
  "delivery": "notice|directive", "content": "",
  "status": "pending|delivered|read",
  "ts": 0
}
```

（`to` 恒为具体 paneId——`all` 只在 msg 工具入参出现，写侧 fan-out 展开为 N 条 `to=<paneId>`。inbox 消息写者 = 发送方（steer=main，msg=各 agent）；status 推进写者 = 收信 pane（pending→delivered→read）；task 文件不存投递态，避免双写竞争。）

状态机（单状态机，事件驱动）：

```
queued ──出队──▶ running ──pane done──▶ done
  ▲        ▲        │── pane aborted ──▶ aborted（终态；resume 请求可重入队）
  │        │        │── deadline 到期（无 pane 信号）──▶ timeout ──重试用尽──▶ failed
  │        │        │── spawn 失败 ──▶ queued（attempts<maxAttempts）/ failed（用尽）
  │        │        │── 取消 ──▶ cancelled
  │        │        └── steer ─▶ running（投递态在 inbox 消息文件推进，不换状态）
  │        │
  │        ├── failed ──重试（attempts<maxAttempts，退避 5s/30s）──▶ queued
  │        └── timeout ──迟到 pane done/aborted 信号──▶ done / aborted（不重跑）
  │
  └── 取消 ──▶ cancelled
```

迁移表（state × event → 次态；M1b 验收依据）：

| 当前态 | 事件 | 次态 | 动作 | 写入者 |
|---|---|---|---|---|
| — | enqueue | queued | 写 task 文件（原子写 tmp+mv） | 派发方 |
| queued | dequeue | running | 分配并发位 + 写 startedAt + allocateSessionDir 先落盘再 spawn | queue 循环（拥有者进程） |
| queued | cancel | cancelled | 标记 | 派发方 |
| queued | resume 请求 | queued | 填 payload.spawn.resumeFrom | 派发方 |
| running | pane done 信号 | done | 读 status/<id>.done | wrapper（pane 进程） |
| running | pane aborted 信号 | aborted | 读 status/<id>.aborted / pane 消失 tick 注入（{paneGone}）+ notifyMain（reason="aborted"） | wrapper trap / queue 循环 |
| running | deadline 到期（无 pane 信号） | timeout | markTimeout + consumeSignal（删除旧 done\|aborted 信号，rm 前复查） | queue 循环 |
| running | spawn 失败（spawnFailed） | queued | attempts+1 回队（动态 retry） | queue 循环 |
| running | attempts 用尽（exhausted） | failed | notifyMain（reason="attemptsExhausted"，states.ts 词汇表权威名） | queue 循环 |
| running | cancel | cancelled | kill pane + 标记 | 派发方 |
| running | steer 注入 | running | 写 inbox 消息（latest-wins + nonce） | main |
| timeout | pane done 信号（迟到） | done | 读 status/<id>.done（不重跑） | queue 循环 |
| timeout | pane aborted 信号（迟到） | aborted | 读 status/<id>.aborted + notifyMain（reason="aborted"） | queue 循环 |
| timeout | retry（attempts<maxAttempts） | queued | attempts+1，killPane（先杀旧 paneId）+ 退避 5s/30s + 写 nextAttemptAt | queue 循环 |
| failed | retry（attempts<maxAttempts） | queued | attempts+1，killPane + 退避 5s/30s + 写 nextAttemptAt | queue 循环 |
| failed/timeout | attempts 用尽 | failed（终态） | 摘要通知 main | queue 循环 |
| aborted | resume 请求 | queued | 填 payload.spawn.resumeFrom | 派发方 |

（resume 边收窄（M3 PR#1）：仅 `aborted × resume → queued` 存在；failed（spawn 用尽无会话可续）/cancelled（用户主动取消）**不支持 resume**，票 08 只收 aborted。）

仲裁：pane 信号优先于 deadline；同一轮询 tick 两者同时到达以 pane 信号为准；**迟到信号修正**：timeout 后 tick 仍查信号，done 存在 → 直接 done 不重跑。retry：maxAttempts=2（最多执行 3 次：初次 + 2 重试），退避 5s/30s（nextAttemptAt 落盘读盘，进程重启不退避归零）；retry 前 kill 旧 paneId（防双 pane）。

关键规则：原子写 tmp+mv（tmp 名 per-writer 唯一）；复用 400ms 轮询禁 fs.watch；安全校验同 uid + 0600 + **读侧单调 watermark**（消息 ts > 本目录已 delivered/read 最大 ts 才接受，首读无 watermark 用 mtime≤60s 兜底；单机共享系统钟，跨写者墙钟偏斜不在威胁模型内），不做 HMAC；嵌套 PI_AGENT_TEAMS_PANE=1 标记，pane 内不注册 spawn、不武装 ticker（M2 临时语义，M3 按 B11 恢复 depth-1 派发）；并发默认 3 + 任务级超时（timeoutSecs）；**单写者矩阵**：task 文件唯一写者 = 拥有者进程；done/aborted 文件唯一写者 = wrapper；usage sidecar 唯一写者 = wrapper；inbox 消息写者 = 发送方、status 推进写者 = 收信 pane；presence 写者 = 各自 pane 进程；渲染器零 task/status/usage 三类文件写（inbox 消息 status 推进归收信 pane 豁免）；**owner 过滤**：scan 只读本进程任务（scanTasks(owner?|null)，null=全量供 farm_status/GC），Queue.step 只写本 owner；GC 由 farm tick 顺带执行。

**GC 表（逐目录）**：tasks 不 GC ｜ inbox 24h（delivered/read + 陈旧 pending 由 main farm GC 顺带 sweep）｜ usage 24h ｜ presence 24h ｜ sessions 7d ｜ requests 1h ｜ status 24h。

- **层级语义（depth 编号以代码口径 1-based 钉死，票 02 统一）**：depth 1 = main 直接派发（角色 agent / worker 形态任务）；2 = 角色 agent 派发（worker）；depth-1 角色 agent 恢复派发（M3 武装 mini-farm，owner=本 pane 进程，gcEnabled:false，并发记账计本 owner）；depth-2 worker 零 farm 工具（无头 `pi -p --mode rpc` 不加载全局扩展，farm_status 不可达，收信归渲染器）；**Queue 层守卫 isDepthGated 翻转 depth≥3**（depth≥2 可出队、depth≥3 不出队兜底，M3 已翻转）。层级恢复 = 扫描 tasks/ 按 parentId 链重建树，不依赖内存。**form 与层级正交（票 02 消歧）**：`payload.spawn.form: "tui"|"worker"` 是形态名（缺省 tui = 完整 TUI 角色 agent；worker = B 形态状态窗口），与身份层级名 worker 不同义——M2.5 的 form:"worker" 任务 = main 直派的 B 形态任务（depth 1）；M3 恢复 depth-1 派发后 depth=2 任务强制 form:"worker"。
- **同名角色并发**：同名角色 agent 可并发多实例：以 taskId 唯一区分，pane/窗口标题带角色名（+taskId 短号；pane 级标题原语 V4 待验证）。
- **边缘语义（P8 六条 + 评审补两条）**：① 广播 0 命中 → 明示无人接收（不静默）；② 广播 1 命中 → 照常单发；③ steer 到终态任务 → 拒绝 + 文案引导 resume/farm_status；④ pi 重启后队列任务去向 → owner 失活 → session_start 僵尸回收 paneAborted + 补发（现有机制）；⑤ 会话级调度「明示」给谁看 → M5 挂账注明；⑥ resume × 7d GC 冲突 → 7d 内可 resume，超期明示回收；⑦ steer 到 queued → 拒绝 + 引导 farm_status / 等 running（paneId 尚未分配）；⑧ 多农场作用域 → 单窗口单 farm，M7 网格 = 同 farm 多 pane。
- **已知限制（M3 假设）**：单窗口单 farm；inbox/presence/usage 共用全局 `~/.pi-agent-teams`，并发双 farm 广播经 presence 跨 farm 串信为已知限制，M7 网格复用同 farm 多 pane。

### 13.4 steer 语义（回合边界软干预）

- steer 在 streaming 中排队，当前回合工具调用全部执行完、下一次 LLM 调用前投递；空闲时 triggerTurn:true 立即触发。长工具阻塞 → UI 标 pending。
- **写侧（main → 角色 agent，单向）**：main 注册 `steer` 工具（targetTaskId + content）→ 解析 targetTaskId 的 task record → 校验 status==running（终态/queued 拒绝 + 文案引导，见 §13.3 边缘语义③/⑦）→ taskId→paneId → Inbox.deliver({type:"steer", from:"main", to:paneId, delivery:"directive", content})。
- **读侧（两条路径共用 comm/inbox.ts 读侧轮询器，watermark 新鲜度）**：TUI 路径（depth-1 角色 agent pane 侧扩展）= pollInbox → pickLatest pending steer → advance delivered → pi.sendMessage({customType:"farm.steer", deliverAs:"steer", triggerTurn:true}) → 收 response 后 advance read；B 路径（depth-2 worker 渲染器）= pollInbox → directive 走 stdin rpc `{"type":"steer"}`（agent_settled 后 `{"type":"prompt"}`，M2.5 A2 已定）→ advance。
- 渲染：registerMessageRenderer("farm.steer") 显示「来自 main」+时间戳+内容（**静态一次性气泡**，不承诺 pending→delivered 实时推进；三态流转仅面板投递态列只读展示），与用户输入区分。拒绝 sendUserMessage（归因混乱）。
- hard kill 缺口：官方无 kill API → 软干预 + 人工关 pane；向 pi 上游提 FR。
- steer 发送方 = main 会话；角色 agent 对 worker 的纠偏复用消息通道（FR5）；用户直连角色窗口仅标记「被用户直连过」不回传全文。

### 13.5 调度两阶段

| 阶段 | 机制 | 语义 |
|---|---|---|
| 一（M5） | 会话内 ticker：扫描 schedule/ 到期执行 | pi 未开时静默失效（明示） |
| 二（M6） | launchd 每分钟唤醒 pi-agent-teams tick CLI（纯 Node）：扫 schedule 文件，到期任务 pi -p 无头执行 | 跨会话存活；OS 设施非自家 daemon；粒度分钟级 |

拒绝复活 daemon（v2 实测 websocket 传输错误 100%）。

### 13.6 capability probe 与 FR9 终端降级链

**A. capability probe**（启动执行，结果写 config.json）：1) pane 内扩展可加载 + PI_AGENT_TEAMS_PANE=1 识别（扩展加载与终端无关）；2) sendMessage steer/followUp 真实行为；3) setActiveTools 生效；4) --session-dir 恢复；5) --append-system-prompt 可用性。**实现修正（M3 票 01）**：4)/5) 原经 `pi --help` 判定，因 `pi --help` 加载扩展→递归拖垮 CPU，已删除进程探测；resume/appendSystemPrompt 改为恒 true（wrapper 既有契约，不探测）。

**B. FR9 三级降级链**：环境信号（TERM_PROGRAM=WezTerm / WEZTERM_UNIX_SOCKET）缺位 → 判 L2；信号在位 → 执行 wezterm cli --no-auto-start list，exit 0 且有 panes → L0，否则 L1。L0=全能力；L1=spawn 拒绝执行 + 明示报错 + 引导内置 subagent（全 mux 级，同窗口所有 tab 受影响，文案明示；不自动路由——自动路由=假成功+语义漂移）；L2=启动警告 + spawn 拒绝 + 引导内置 subagent；任务不落盘不静默丢失。**探测时机**：启动探测写 config.json + 每次 spawn 前轻量重探（一次 list）。**存活探测**：3s 间隔（仅存在 running 任务时），pane 消失 → tick 注入 aborted。与 A 正交。

### 13.7 范围纪律（明确不做）

通用事件总线/pubsub 基建；无头 JSON 执行作为 farm 功能（B 形态 worker 状态窗口除外：pane 内渲染可见，M2.5）；跨平台/跨终端（锁定 macOS + WezTerm 单目标）；crew 三层及以上 / 角色间从属 / 自动扩编（两层封顶）；实时 token 成本监控（官方数据源断裂 #7911，事后估算）；跟随社区项目高频版本 churn；文件强预留（只做提示性约定）。

### 13.8 风险与缓解

| 风险 | 缓解 |
|---|---|
| steer 无硬中断（长工具阻塞） | 软干预定位 + pending 状态 + 上游 feature request |
| launchd 无头执行环境 | TUI 可用性 guard + M6 先 spike 对端分发 |
| 队列并发撞 API 限流 | 并发上限默认 3 可配 + 任务级超时 |
| #7730 长会话高 CPU | 任务 pane 短生命周期（v2 watchdog）+ 监控会话轻渲染 + 会话轮转 |
| 版本漂移（pi / wezterm cli 快速迭代） | 启动 probe + 三级降级链 + 待验证清单优先验证 + 版本号记录 |
| steer 文件伪造 | uid/0600/新鲜度校验（同用户信任边界，残余风险明示） |
| CI 无 WezTerm 不能 E2E | task-core/comm 纯文件协议 Linux 单测全覆盖；E2E 保留本地 smoke-test.sh |
| L1 全 mux 级波及所有农场 tab | 文案明示 + 单窗口模型天然接受该语义 |
| 上下文膨胀（4+ 工具 schema） | setActiveTools 默认只开 spawn+queue；followUp 只发摘要 |

### 13.9 待验证清单（M2 开工实机验证）

Wave1 降级链（最阻塞）：V1 --no-auto-start list 在 L1 下的确切 stderr/exit code → V6 wezterm cli 并发调用竞态 → V7 pane 外执行 list 的连接行为（--prefer-mux）→ V8 L1 全 mux 级语义实测。Wave2 窗口原语：V2 kill 最后一 pane 后 tab 是否自动关闭 → V9 zoom-pane 窄屏缓解（FR2，is_zoomed 回读）→ V4 pane 级标题（OSC 0/2 或 Lua set_title；失败则 set-tab-title 回退）。M2 需用部分：V5/V11 只验 list 的 pane-id 稳定唯一性（steer/msg 通道串扰全量留 M3）。改期：V3（get-text 回读保真度）与 V10（无头审批行为）→ M2.5 立项前补测。输出物：.scratch/m2-background-mode/spike-facts.md 原始样本（list JSON 完整字段清单 / L1 stderr 原文 / 各 V 项结论），T4/T8 无样本不得落码。

**✅ 实机验证完成（2026-08-13，wezterm 20260812-070121-fe3006ae，结果全文见 spike-facts.md）**：V1 ✅ exit 1 + stderr `failed to connect to Socket(`（stdout 空）→ 该 stderr 模式是 L1 唯一可靠判据（运行时错误同样 exit 1，stderr 不同）。V6 ✅ 5 并发 list 逐字节一致、无竞态（单次 ~1.2s 开销）。V7 ✅ pane 外默认连接经 default 域 symlink 直连 GUI 成功；`--prefer-mux` 在无 mux server 时硬失败、无 GUI 回退 → **禁用 --prefer-mux**。V8 ✅ L1 下 7 个子命令统一失败、无部分可用语义 → 全 mux 级降级成立。V2 ✅ kill 最后一 pane 自动关 tab、关最后 tab 自动关窗口，无空 tab 残留。V9 ✅ zoom-pane --zoom/--unzoom 后 is_zoomed 回读正常。V4 ✅ pane 级标题走 **OSC 0**（仅写 pane title，不污染 window_title），无需回退；set-tab-title 已验证作兜底。V5/V11 ✅ pane-id 全局单调、跨调用稳定、跨窗口唯一、不复用。附带：spawn stdout 直接打印新 pane-id；spawn 默认 cwd=$HOME（farm 必须显式 --cwd）；cwd 为 file:// URI（macOS /tmp→/private/tmp）。

---

### 13.10 评审整改台账（三代理交叉评审，2026-08-13）

基线：PRD v0.4 交叉评审（.scratch/PRD-v3-review/review-report.md，三份 BLOCKED 有条件放行）。整改按里程碑分阶段落盘，未到期的项不得提前实现（防膨胀）。

| 评审项 | 整改要点 | 归属 | 状态 |
|---|---|---|---|
| B2 状态机缺边 / steered 枚举矛盾 | 7 态 + 完整迁移表 + retry 数值（maxAttempts=2、退避 5s/30s）+ pane 信号优先仲裁 | M1b | ✅ 本次落盘（§13.3） |
| B5 task record 缺字段 | timeoutSecs/attempts/payload 各 type/result.cost 结构 + 写者矩阵 | M1b | ✅ 本次落盘（§13.3） |
| X2 工具数矛盾（4 vs 5） | 统一 2/5（§8.8） | M1b | ✅ 本次落盘 |
| B1 FR1 机制悬空（run_in_background 不存在） | farm 循环生命周期（§13.2） | M2 前 | ✅ 本次落盘 |
| X1 pane 生命周期 vs watchdog 自动关窗 | 拍板：wrapper.sh 保留 watchdog（豁免规则），countdown 删除立即自关；pane 消失探测归拥有者 farm 循环（{paneGone} tick 注入） | M2 | ✅ 本次落盘（§13.2/§13.3） |
| F3 steer 渲染 API 事实错误 | steer 属 M3，随 M3 一并整改（sendMessage deliverAs:"steer" + registerMessageRenderer 静态气泡；以票 03 完成真实 SDK 形状核验为前提） | M3 开工前 | ✅ 本次落盘（§13.4） |
| F1 状态面板零实现设计 | 拍板：M2 状态列表 = farm_status 工具（5 列 + 详情）；setWidget 面板推迟 M2.5 与 B 形态渲染器合并（**M2.5 交付 pane 内渲染器，setWidget API 适配挂 M3**，decisions.md #5） | M2 / M2.5 / M3 | ✅ M2 落盘，M2.5 票 02 翻转 |
| B3 全局 AGENTS.md 禁改 vs M2 修订矛盾 | 拍板（用户 2026-08-13）：随 M2 切换修订，范围仅 spawn_visible_agent 语义段（不干等、farm.done 到达后再汇报），改前给用户看 diff | M2（T8 执行） | ✅ 已执行（2026-08-13 切换时写入，diff 用户过目） |
| 通知通道形态（followUp 打断语义） | 拍板：聚合 followUp——每 step 收集、≥2s flush 1 条、triggerTurn:true（pi 文档实证：等 agent 完成才投递，不打断工具执行） | M2 | ✅ 本次落盘（§13.2） |
| B4 新鲜度 vs 排队 steer / B7 单写者残余 / B8 list 轮询频率 / B12 迁移小节 / F4 触发器 / F8 进度循环 / F10 L1/L2 注册策略 / P7 基线对齐 | 处置：B4 M2 无 steer（M3），60s 新鲜度沿用；M3 已落盘 watermark 裁决 ✅§13.3/§13.4；B7 三合一 owner 过滤 + {paneGone} tick 注入 ✅§13.3；B8 3s 探测仅 running 时 ✅§13.6；B12 6 边 + 词汇表增补 ✅§13.3；F4 resume 工具 M3，M2 保证恢复命令可见 ✅；F8 farm_status 5 列+详情 ✅，面板 M2.5；F10 注册但执行拒绝+文案引导 ✅§13.6；P7 基线 = 部署 v2.0.1 行为 ✅§8.10 | M2 开工前 | ✅ 本次落盘 |
| B11 PI_AGENT_TEAMS_DEPTH 透传 / F5 a11y 文本前缀 / X4+B9 GC 对齐 FR4 / 边缘语义 6 条（P8） | 各 1-2 句修订：B11 见 §13.2/§13.3 层级语义、F5 a11y 文本前缀见 §13.4 渲染、X4+B9 GC 表见 §13.3、边缘语义 8 条见 §13.3 末尾 | M3 开工前 | ✅ 本次落盘 |
| B10 M6 spec 重写（可见性/状态迁移所有权/cron TZ/DST）+ M6 无头边界拍板 | 整节重写 | M6 开工前 | ⬜ |
| P3 技术债归属 / P4 成功指标 / P9 §7 口径 / B14 notice 落点 / B15 威胁模型 / P6 竞品措辞 / F9 V 项 fallback | 就近修订 | 移出 M7（就近挂账，M8+） | ⬜ |
| F7 窄屏 | zoom-pane 手动缓解（M7 defer 已定案，见 §4.10/§13.2 网格口径） | M7 已处置 | ✅ defer |
| E2E 摩擦 4 项（迟到 done 信号被静默丢弃 / nextAttemptAt 无公开读口 / buildResumeArgs 纯位置契约 / Inbox ts 多进程撞平） | 处置：① 迟到 done → timeout×paneDone 修正边 ✅§13.3；② nextAttemptAt → 落盘 + farm_status 详情展示 ✅§13.3；③ 位置契约 → wrapper env-only 契约 + farm_status 展示完整恢复命令 ✅§13.2；④ Inbox ts 撞平 → M3 裁定不扩 schema（ts 保持非唯一 nonce，撞平以 msgId 字典序破序）✅§13.3 | M2 开工前 | ✅ 本次落盘 |
| M3 票 01 spawn_visible_agent 超时根因（启动探测 `pi --help` 递归） | 处置：删除 `execPiHelp` + `ProbeDeps.execHelp`，resume/appendSystemPrompt 恒 true（偏离挂账「改 --version」——`--version` 无法揭示 flag 支持，且两 flag 是 wrapper 既有契约）；工程门 3e 禁引号内 `--help` 参数防复发 | M3 第一优先调查 | ✅ 本次落盘（票 01） |
| -e project_trust 可编程扩展（M2.5 挂账） | defer M4+：--approve（M2.5 已恒带）已覆盖 farm scratch .pi/ 资源加载门，可编程信任是精细化增强、非 M3 阻塞项 | M4+ | 🟡 挂账（偏离原「挂 M3」） |
| M7 收尾（网格 + 成本 + 分发） | 网格落点 = `--pane-id` 分裂最大 pane（`--top-level` spike 否定：tab 根分裂越新越大）+ `computePlacementFromSnapshot` 兑底（WEZTERM_PANE 缺失→最小 pane_id 推断 own）；成本换算层 = src/pricing.ts + ~/.pi-agent-teams/pricing.json（用户可配、只读不写）；分发文档 = docs-internal/DISTRIBUTION.md。610 单测 + tsc 零错 + grep 白名单 + wrapper 三处一致 | M7 | ✅ 代码完成（网格 + 成本面板实机 smoke 通过） |

---

*已审查拍板（v0.5 身份模型 = 两层 agent teams：D7 身份 / D8 人设 / D9 开会最小形态；B 形态立 M2.5）：M1b 在新工作区开工，本文件仍是唯一计划文档，任何功能增删先改这里。*
