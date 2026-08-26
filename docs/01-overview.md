# 第一部 · 入门：产品、架构与安装（CH1–3）

> 读者：👤 人类优先（🤖 AI agent 也建议读 CH2）
> 本部分读完你能：理解 pi-agent-teams 是什么、它的运行模型、并完成安装/升级/卸载。

---

## CH1 产品是什么

### 1.1 一句话定位

`pi-agent-teams` 是一个终端优先的 [pi](https://github.com/earendil-works/pi) 扩展：把单个 pi 编码 agent 会话升级为 **agent teams 工作台**——每个 agent 跑在**真实的 WezTerm 终端 pane** 里（可见、可打字、可指挥），而不是黑盒子的 subagent。

它把社区多 agent 工具的"任务管理能力"（队列/指挥/恢复/调度）与**可见性**结合起来：派出去的 agent 就像屏幕上真实的队友，你可以看它干活、随时纠偏。

### 1.2 能力总览

| 能力 | 一句话说明 | 涉及工具/机制 |
|---|---|---|
| 后台并行派发 | 派角色 agent 进新 pane，立即返回不阻塞主会话 | `spawn_visible_agent` |
| 同步等待 | 阻塞至任务完成并取回结果 | `spawn_visible_agent(sync: true)` |
| 自动排队 | 超过并发上限（默认 3）自动排队 | 队列（自动） |
| 中途指挥 | 对运行中 agent 回合边界软干预 | `steer` |
| agent 间通信 | 点对点 / 广播（notice / directive） | `msg` |
| 开会模式 | 广播议程 → 各回一回合 → main 汇总 | `msg` directive 广播 |
| 任务恢复 | 从上次对话恢复 aborted 任务 | `farm_resume` |
| 状态查询 | 任务台账 / 详情 / 过滤 | `farm_status` |
| 状态面板 | 主会话常驻 7 列面板 | setWidget（自动） |
| 成本估算 | token → 费用（事后统计） | usage + `pricing.json` |
| 网格布局 | 新 pane 分裂最大 pane，形成平衡布局 | 自动（M7） |
| 工作区隔离 | 每项目（cwd）独立 farm，互不干扰 | 自动（C1） |

### 1.3 环境边界（先确认你符合）

| 项 | 要求 |
|---|---|
| 操作系统 | macOS（WezTerm 单目标，ADR-0001） |
| 终端 | WezTerm（`wezterm cli` 可用） |
| Node | ≥ 22（type-stripping 直接跑 `.ts`，零 node_modules） |
| TypeScript | 全局安装（类型门 `tsc --noEmit`） |
| pi | 0.84.x（PATH 内） |

> 不符合上述环境 → 插件会按降级链（L1/L2）**拒绝派发并引导使用内置 subagent**，任务永不静默丢失（详见 CH17）。

### 1.4 与内置 subagent 的对照

见 [docs/README.md](README.md)「与内置 subagent 工具的对照」表。核心结论：**需要并行多角色、中途指挥、可见性 → 用本插件；轻量单次委派、不需要窗口 → 用内置 subagent**。

---

## CH2 架构一页图

### 2.1 组件架构

```
┌─────────────────────────────────────────────────────────────┐
│  main pi 会话（扩展 index.ts）                               │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                 │
│  │ task-core │ │ display   │ │ comm      │                 │
│  │ 状态机/队列│ │ WezTerm   │ │ inbox     │                 │
│  │ resume/   │ │ cli 原语  │ │ presence  │                 │
│  │ schedule  │ │ B 形态渲染│ │ feed      │                 │
│  └───────────┘ └───────────┘ └───────────┘                 │
│        │             │             │                       │
│  ┌─────┴─────────────┴─────────────┴──────────────────┐    │
│  │ ~/.pi-agent-teams/<wsId>/  （每工作区一份）          │    │
│  │ tasks/ status/ sessions/ inbox/ presence/ usage/   │    │
│  │ ~/.pi-agent-teams/  （全局：pricing/config）        │    │
│  └───────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
        │ spawn / steer / msg / resume
        ▼
┌─────────────────────────────────────────────────────────────┐
│  agent panes（WezTerm 分屏）                                │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐              │
│  │ 角色 agent │ │ 角色 agent │ │ worker     │              │
│  │ (TUI 完整) │ │ (TUI 完整) │ │ (B 形态:   │              │
│  │            │ │            │ │  状态窗口 + │              │
│  │            │ │            │ │  背后 pi -p)│              │
│  └────────────┘ └────────────┘ └────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 运行模型要点

- **五个工具**在 main 进程执行（`spawn_visible_agent` / `steer` / `msg` / `farm_resume` / `farm_status`），副作用是**文件通道 + WezTerm CLI**。
- **wrapper.sh** 是每个 agent pane 侧的生命周期进程（env-only 契约，单写者）：负责启动 agent、回收结果、写状态信号、提取用量。
- **任务数据落盘**：每工作区一份 `~/.pi-agent-teams/<workspaceId>/`；全局配置（pricing/config）在 `~/.pi-agent-teams/`。
- **不变量**：零第三方依赖（无 package.json / node_modules）；`index.ts` 是唯一运行时边界。

### 2.3 数据落盘

| 目录/文件 | 用途 |
|---|---|
| `tasks/<taskId>.json` | 任务记录（单一事实源） |
| `status/<taskId>.done\|.aborted\|.result\|.consumed` | 终态信号 / 结果摘要 / 消费标记 |
| `sessions/<taskId>/` | pane 会话 JSONL（结果与用量数据源） |
| `inbox/<paneId>/` | steer/消息投递箱 |
| `presence/<taskId>.json` | 心跳注册表（3s 一次） |
| `usage/<taskId>.json` | 用量 sidecar（wrapper 写） |
| `requests/<taskId>.agent-prompt` | 人设临时文件（GC 1h 回收） |

> 人类读者：本图只需记住"**任务数据在 `~/.pi-agent-teams/` 下**"。文件协议细节见 CH8（高级）。

---

## CH3 安装、升级与卸载

### 3.1 前置条件确认

```bash
node --version        # ≥ 22.x
tsc --version         # ≥ 7.0
wezterm cli --no-auto-start list   # 有 panes 输出 = 底座可用
which pi              # pi 在 PATH
```

### 3.2 安装（三步）

```bash
# 1. 同步扩展到 pi 的扩展目录（排除测试文件）
rsync -a --exclude='*.test.ts' \
  src/ ~/.pi/agent/extensions/pi-agent-teams/

# 2. 验证 wrapper.sh 三处逐字节一致（必须为空 diff）
diff assets/wrapper.sh ~/.pi/agent/extensions/pi-agent-teams/assets/wrapper.sh
diff assets/wrapper.sh ~/.pi-agent-teams/wrapper.sh

# 3. 重启 pi 主会话（或 /reload）——扩展生效
```

> wrapper.sh 是 env-only 契约，三处（源码 `assets/` / 部署副本 `assets/` / 运行时 `~/.pi-agent-teams/`）必须**逐字节一致**；不一致会导致 pane 启动失败。

### 3.3 验证安装

- [ ] 工具列表中能看到 5 个工具：`spawn_visible_agent` / `steer` / `msg` / `farm_resume` / `farm_status`；
- [ ] 首次 spawn 后生成 `~/.pi-agent-teams/<wsId>/`；
- [ ] spawn 后 WezTerm 右侧弹出 agent pane。

### 3.4 升级

重复 3.2 的三步即可。**升级不清数据**——任务数据在 `~/.pi-agent-teams/`，不在扩展目录。

### 3.5 卸载

1. 先结束/确认运行中任务（或等队列清空）——运行中任务依赖 pane 进程；
2. 移除扩展目录 `~/.pi/agent/extensions/pi-agent-teams/`；
3. （可选）删除运行时数据 `~/.pi-agent-teams/`（含 wrapper.sh）；
4. 重启 pi 主会话。

### 3.6 常见安装错误

| 症状 | 可能原因 | 解法 |
|---|---|---|
| spawn 被拒，提示非 WezTerm 环境 | L2 降级（`TERM_PROGRAM` 非 WezTerm） | 在 WezTerm 中运行 pi（见 CH17） |
| spawn 被拒，提示 mux 连接失败 | L1 降级（WezTerm GUI/mux 不可达） | 恢复 WezTerm 后重试（见 CH17） |
| 工具列表看不到 5 工具 | 扩展未同步/未 reload | 重跑 rsync + 重启主会话 |
| pane 启动失败 | wrapper.sh 三处不一致 | diff 三处并 `cp` 补齐 |
| 未知角色报错 | 人设文件缺失 | 在 `~/.pi/agent/agents/` 放 `<name>.md` 后 `/reload` |
