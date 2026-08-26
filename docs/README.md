# pi-agent-teams 使用手册

> 版本：v1.0（2026-08-26，对应 M8 状态）· 语言：简体中文
> 本手册面向**两类读者**：①人类用户（安装、配置、日常使用、排障）；②其他 AI agent（作为 pi 的主 agent，需要正确驱动插件的 5 个工具）。**无需阅读源码**即可上手。

---

## 手册目录

| 文件 | 章节 | 主题 | 主要读者 |
|---|---|---|---|
| [01-overview.md](01-overview.md) | CH1–3 | 产品是什么、架构一页图、安装/升级/卸载 | 人类优先（AI 也需 CH2） |
| [02-concepts.md](02-concepts.md) | CH4–8 | 三层级体系、任务状态机、工作区隔离、并发/成本、数据协议 | 双读者（CH8 高级） |
| [03-tools.md](03-tools.md) | CH9–14 | 五个工具逐一契约 + 状态面板 | **AI agent 优先** |
| [04-ops.md](04-ops.md) | CH15–20 | 典型工作流、会议模式、降级链/排障、配置、已知限制、AI 决策卡 | 双读者 |

章节编号 CH1–CH20 贯穿四份文件连续编排。

---

## 阅读路径

**人类读者**（想把插件用起来）：

1. 先读 [01-overview.md](01-overview.md) 的 CH1（产品概览）与 CH3（安装）——装好、跑起来；
2. 用 [04-ops.md](04-ops.md) 的 CH15（典型工作流）走一遍完整流程；
3. 遇到问题时查 [04-ops.md](04-ops.md) 的 CH17（故障排查）；
4. 按需回看 [02-concepts.md](02-concepts.md) 理解概念、[04-ops.md](04-ops.md) 的 CH18（配置）调成本。

**AI agent 读者**（作为 pi 主 agent 驱动插件）：

1. 快速读 [02-concepts.md](02-concepts.md)（CH4 层级、CH5 状态机、CH6 工作区——理解任务模型）；
2. **精读 [03-tools.md](03-tools.md) 全文**（五工具契约：参数、返回值、误用、示例）；
3. 调用前查 [04-ops.md](04-ops.md) 的 CH20 决策卡（条件 → 该用哪个工具）；
4. 遇到降级/异常读 CH17。

---

## 功能速览

| 能力 | 一句话说明 | 涉及工具 |
|---|---|---|
| **派发** | 把角色 agent 派进真实 WezTerm pane，立即返回不阻塞主会话 | `spawn_visible_agent` |
| **同步等待** | 阻塞至任务完成并取回结果（摘要/exitCode/费用） | `spawn_visible_agent(sync: true)` |
| **排队** | 超过并发上限自动排队（默认并发 3） | 自动 |
| **指挥** | 对运行中的 agent 回合边界软干预（"改用方案 B"） | `steer` |
| **通信** | agent 间点对点 / 广播（notice 只显示 / directive 触发行动） | `msg` |
| **开会** | 广播议程 → 各 agent 回一回合 → main 汇总 | `msg`（directive 广播） |
| **恢复** | 从中断处恢复 aborted 任务（≤7d 窗口） | `farm_resume` |
| **状态查询** | 任务列表（5 列台账）/ 单任务详情 / 按状态过滤 | `farm_status` |
| **状态面板** | 主会话常驻 7 列面板（taskId/role/status/attempts/耗时/usage/费用） | 自动（setWidget） |
| **成本估算** | token → 费用（事后统计，价目表用户可配） | 自动 + `pricing.json` |
| **工作区隔离** | 每个项目（cwd）独立任务空间，互不干扰 | 自动 |

---

## 与内置 subagent 工具的对照（何时用哪个）

| 维度 | pi-agent-teams | pi 内置 subagent |
|---|---|---|
| 可见性 | 每个 agent 一个**真实终端 pane**，可看可打字 | 黑盒，无独立窗口 |
| 交互方式 | 用户/其他 agent 可中途 steer、发消息 | 只等最终结果 |
| 排队 | 支持（并发上限 + 自动排队） | 不支持 |
| 结果获取 | 异步 farm.done 通知 / `sync: true` 阻塞取回 | 同步返回 |
| 恢复 | `farm_resume` 恢复 aborted | 无 |
| 适用场景 | 并行多角色协作、需要中途指挥/通信、可见性敏感 | 轻量单次委派、不需要可见性 |

> 环境降级（L1/L2，见 CH17）时插件拒绝派发并引导使用内置 subagent 工具。

---

## 术语快引

| 术语 | 含义 | 详见 |
|---|---|---|
| **farm** | 一组同属一个工作区的 agent pane | CH2/CH6 |
| **pane** | 运行一个 agent 的 WezTerm 分屏窗口 | CH2 |
| **taskId** | 任务的唯一标识（前 8 位常用于显示/引用） | CH5 |
| **depth** | 层级深度：main=0、角色 agent=1、worker=2 | CH4 |
| **workspaceId** | 由 cwd 派生的工作区标识（sha256 前 12 hex） | CH6 |
| **wrapper** | pane 侧生命周期进程（`wrapper.sh`） | CH2 |
| **回合（turn）** | agent 一轮工具调用 + 回复的完整周期 | CH5 |
| **agent persona** | 角色人设文件（`~/.pi/agent/agents/<name>.md`） | CH4 |
| **B 形态（worker form）** | 自定义状态窗口形态（背后 `pi -p` 无头跑） | CH4 |

---

## 文档状态

- 本手册基于 **M8 完成状态**（2026-08-26）：五个工具恒定、sync 等待、会议模式、成本面板、工作区隔离均已交付。
- **未交付/已搁置**：M5/M6 定时调度（schedule 解析器预留、无 ticker）、多农场、非 WezTerm/macOS 平台——见 [04-ops.md](04-ops.md) CH19。
- 仓库内其他文档：[README.md](../README.md)（中英功能概览）、[CONTEXT.md](../CONTEXT.md)（领域词汇，术语权威快照）。
