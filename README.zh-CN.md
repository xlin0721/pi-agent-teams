# pi-agent-teams

**pi 的可见多智能体协作工作台（visible multi-agent orchestration）——把角色 agent 派进真实终端分屏，可中途指挥、排队干活、agent 间互发消息、开会讨论。每个 agent 都看得见、可交互。**

`pi-agent-teams` 是一个终端优先的 [pi](https://github.com/earendil-works/pi) 扩展，把单个 pi 编码 agent 会话升级为 **agent teams 工作台**。与黑盒子代理不同，你派出的每个 agent 都运行在**真实的终端 pane** 里——你可以看着它干活、直接打字指挥、随时纠偏。

---

## 为什么做这个

社区的多 agent 工具（任务管理器、消息中继）都在聊天界面里以列表形式展示 agent。`pi-agent-teams` 的不同之处在于：**每个 agent 都跑在一个真实、可见、可打字的终端 pane 里**——就像屏幕上坐着真实的队友。

| 能力 | 说明 |
|---|---|
| **派发** | `spawn_visible_agent` — 派一个角色 agent（完整 TUI、全量工具权限）进新 pane，立即返回不阻塞主会话 |
| **排队** | 超过并发上限自动排队，无需人工调度 |
| **指挥** | `steer` — 运行中改方向（"改用方案 B"），回合边界软干预 |
| **通信** | `msg` — agent 间点对点 / 广播（notice 只显示 / directive 触发行动） |
| **恢复** | `farm_resume` — 从上次对话恢复 aborted 任务 |
| **开会** | 广播议程 → 各 agent 各回一回合 → main 汇总 |
| **状态面板** | `setWidget` 面板：taskId / role / status / attempts / 耗时 / **费用** |
| **网格布局** | 新 pane 分裂最大 pane，形成平衡农场布局（M7） |
| **成本面板** | token → 估算费用（事后估算，价目表用户可配） |

---

## 快速开始

### 前置条件

| 项 | 要求 |
|---|---|
| macOS | WezTerm 单目标（ADR-0001） |
| [WezTerm](https://wezfurlong.org/wezterm/) | `wezterm cli` 可用 |
| Node ≥ 22 | 直接跑 `.ts`（type-stripping），零 `node_modules` |
| TypeScript | 全局安装（类型门 `tsc -p tsconfig.json --noEmit`） |
| [pi](https://github.com/earendil-works/pi) 0.84.x | `pi` 在 PATH |

### 安装

```bash
# 1. 同步扩展到 pi 的扩展目录
rsync -a --exclude='*.test.ts' \
  src/ ~/.pi/agent/extensions/pi-agent-teams/

# 2. wrapper.sh 三处必须一致
diff assets/wrapper.sh ~/.pi/agent/extensions/pi-agent-teams/assets/wrapper.sh
diff assets/wrapper.sh ~/.pi-agent-teams/wrapper.sh

# 3. 重启 pi 主会话（或 reload）——扩展生效
```

### 使用示例

```text
你：派 3 个 agent 并行——一个产品主管、一个前端主管、一个后端主管。我继续聊我的。

pi： ✅ task 1a2b3c (product-lead) 排队中 → 运行中
    ✅ task 2b3c4d (frontend-lead) 排队中 → 运行中
    ✅ task 3c4d5e (backend-lead) 排队中 → 运行中
    （右侧弹出 pane，各自显示 agent 的实时工作）

你：（看到前端主管跑偏）steer 2b3c4d —— 守住 M7 范围，不做 reflow。

你：farm_status
    → 5 列台账：taskId / role / status / attempts / 耗时
```

> 📖 文档整理中 — 公开的使用/功能指南将补充到 `docs/` 下。

---

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│  main pi 会话（扩展 index.ts）                              │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                 │
│  │ task-core │ │ display   │ │ comm      │                 │
│  │ 队列/状态 │ │ wezterm   │ │ inbox     │                 │
│  │ 存储      │ │ cli/渲染  │ │ presence  │                 │
│  └───────────┘ └───────────┘ └───────────┘                 │
│        │             │             │                       │
│  ┌─────┴─────────────┴─────────────┴──────────────────┐    │
│  │ ~/.pi-agent-teams/（单一事实源）                   │    │
│  │ tasks/  status/  sessions/  inbox/  usage/  ...   │    │
│  └───────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
        │ spawn / steer / msg / resume
        ▼
┌─────────────────────────────────────────────────────────────┐
│  agent pane（WezTerm）                                      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐              │
│  │ 角色 agent │ │ 角色 agent │ │ worker     │              │
│  │ (TUI)      │ │ (TUI)      │ │ (B 形态：  │              │
│  │            │ │            │ │  状态窗口  │              │
│  │            │ │            │ │  + 无头    │              │
│  │            │ │            │ │  pi -p)    │              │
│  └────────────┘ └────────────┘ └────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

- **task-core/** — 纯逻辑状态机 + 队列 + 恢复 + 调度（零依赖）
- **display/** — WezTerm CLI 原语 + 终端渲染器（B 形态 worker 窗口）
- **comm/** — 文件通道通信：inbox / presence / feed
- **farm/** — 编排循环：派发、通知（`farm.done`）、GC、mini-farm（depth ≥ 2）
- **probe.ts / steer-tool.ts** — 能力探测、降级链、steer/msg/resume 工具
- **assets/wrapper.sh** — pane 侧生命周期进程（env-only 契约，单写者）

### 关键不变量

- **零第三方依赖** — 无 `package.json` / `node_modules`；pi SDK import 仅限 `index.ts`（唯一运行时边界）
- **单写者矩阵** — task 文件：所属队列；done/aborted：wrapper；usage sidecar：wrapper；inbox：发送方；presence：各 pane 进程
- **WezTerm 单目标** — macOS；环境不可用时优雅降级（L0/L1/L2）

---

## 文档

- [PRD-v3.md](PRD-v3.md) — 需求 / 里程碑 / 技术设计（唯一计划文档）
- [CONTEXT.md](CONTEXT.md) — 领域词汇表

> 📖 文档整理中 — 公开的使用/功能指南将补充到 `docs/` 下。

---

## 状态

- M0–M7 全部完成：task-core → 后台模式 → B 形态 worker 窗口 → 指挥（steer/msg/resume/面板）→ 开会 → 网格 + 成本 + 分发文档
- 610 单测全绿 + `tsc` 零错 + grep 白名单全过
- M5（会话级定时）/ M6（系统级定时）按决策延期

## License

待定 — 咨询维护者。
