# 第三部 · 工具参考：五工具契约 + 状态面板（CH9–14）

> 读者：🤖 **AI agent 优先**（👤 人类也可参考）
> 本部分是驱动插件的**核心契约文档**。每章按统一模板：用途 → 何时调用 → 参数 → 返回值 → 误用与陷阱 → 示例。

---

## 第三部开篇 · 通用约定（先读，不占章号）

1. **工具在 main 进程执行**：副作用是文件通道 + WezTerm CLI；任务结果以 **`farm.done` 通知异步到达**（taskId/role/status/耗时/exitCode）。
2. **铁律：farm.done 通知到达前，不得假设或编造任务结果**。不要在 spawn 返回 taskId 后立刻假装结果存在。
3. **taskId 不可猜**：由工具返回，不要自行构造或推断。
4. 需要同步结果时用 `spawn_visible_agent(..., sync: true)`（阻塞）或内置 subagent 工具；默认异步。
5. **任务永不静默丢失**：降级（L1/L2）时拒绝派发并给出引导，绝不假装成功。

---

## CH9 spawn_visible_agent（核心工具）

### 9.1 用途

把角色 agent 派进一个**新的 WezTerm pane**（右分屏），带实时输出；或阻塞取回结果（sync）。

### 9.2 何时调用

- 用户要求"派/开/让某个 agent 干活"、需要多 agent 并行；
- 用户要求所有 subagent **可见**（分屏 pane）；
- 需要指定角色人设并行协作。

### 9.3 参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `task` | string | 必填 | 任务提示词（**前 ~40 字会成为 pane 标题，务必言简意赅**） |
| `agent` | string（枚举） | 可选 | 人设名（来自 `~/.pi/agent/agents/*.md`）；非法名被拒 |
| `cwd` | string | 当前目录 | 子代理工作目录 |
| `timeout_secs` | int ≥1 | 600 | 每尝试超时秒数；超时重试（max 2 次） |
| `form` | "tui" \| "worker" | "tui" | 显示形态；depth≥2 强制 "worker"（入参被忽略） |
| `sync` | bool | false | true = 阻塞至终态并返回结果（spawn-and-wait） |
| `wait_timeout_secs` | int ≥1 | 120（上限 600） | 仅 sync 模式；等待超时含排队时长 |

### 9.4 返回值

**异步（sync=false，默认）**——立即返回：

```
taskId（前 12 位）+ 排队位置
- 有空位：「▶️ 队列有空位，即将在 WezTerm 新 pane 开始」
- 满载：「⏳ 已排队，位置 N（并发上限 3，有空位自动开始）」
结果异步经 farm.done 通知到达（taskId/role/status/耗时/exitCode）
```

**同步（sync=true）**——阻塞至终态返回：

```
{ taskId, status, exitCode, sessionDir, result 摘要, cost, waitedMs, resultSource }
- 完成：✅ 任务 <id> 完成（耗时 X.Xs）+ exitCode + 模型 + 结果摘要 + sessionDir
- 超时：⏳ UNFINISHED 快照 { taskId, status, unfinished: true, timeout } + 指引（farm_status / farm_resume）
- 取消：⏳ 等待被取消 + 指引
```

> 同步模式内部：写 `status/<id>.consumed` + `notifiedAt` → **不会重复收到 farm.done**。

**降级拒绝**（L1/L2）：❌ 无法派发 + 原因 + 引导改用内置 subagent。**任务未落盘，无 taskId**。

### 9.5 误用与陷阱

| 陷阱 | 正确做法 |
|---|---|
| 满载时用 sync 等排队任务 | 异步 + `farm_status` 查进度 |
| 提示词太长，pane 标题无信息量 | 前 40 字写清任务主题 |
| farm.done 未到就假设结果 | 等通知；或 sync 取结果 |
| 担心重复通知 | 不会——consumed 去重保证单次 |
| 用 sync 做长时间等待（>600s） | 拆分任务或异步 + 轮询 |
| 传 `title`/`destroy_delay_secs` 参数 | 会被忽略（prepareArguments 剥离） |

### 9.6 示例

```jsonc
// 1. 异步并行派 3 个 agent（推荐日常用法）
{ "task": "梳理当前模块的 API 契约并输出清单", "agent": "tech-director" }
{ "task": "审查 PR 的代码规范", "agent": "reviewer" }
{ "task": "为接口补齐集成测试", "agent": "e2e-tester" }

// 2. sync 拿单任务结果（需要立即使用结果时）
{ "task": "执行 smoke-test.sh 并报告结果", "agent": "e2e-tester", "sync": true, "wait_timeout_secs": 300 }

// 3. 指定 cwd / form
{ "task": "在子目录跑构建", "agent": "worker", "cwd": "/path/to/project", "form": "worker" }
```

---

## CH10 steer（中途纠偏）

### 10.1 用途

对**运行中**的 agent 发一条指令，在**回合边界**软干预（当前这轮工具跑完后送达）。

### 10.2 何时调用

- 观察到 agent 跑偏，需要"改用方案 B"式重定向；
- 用户要求"让它停下/换个方向"（注意：**不是硬中断**）。

### 10.3 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `targetTaskId` | string | 目标任务（**必须是 running**） |
| `content` | string | 指令内容 |

### 10.4 返回值与行为

- 成功：`✅ 已向 <taskId8> 发送 steer（其当前工具跑完后生效）`；
- 拒绝（目标非 running）：`❌ ... 仍在排队（queued）/已结束（done...）/超时重试中（timeout）`；
- 未找到：`❌ 未找到任务 <id>`；
- **无"已送达"回执语义**——可能到下一回合才生效；agent 窗口内带来源标注显示「来自 main」。

### 10.5 误用与陷阱

| 陷阱 | 说明 |
|---|---|
| 以为 steer 是硬中断 | 不是——长工具调用只能等它跑完这一轮（官方无 kill API） |
| 对 queued / 终态任务 steer | 被拒绝，先 `farm_status` 确认 running |
| 重复 steer | 每轮送达一次，别刷屏 |

### 10.6 示例

```jsonc
{ "targetTaskId": "2b3c4d5e", "content": "stick to the M7 scope, no reflow" }
```

---

## CH11 msg（通信与开会）

### 11.1 用途

给其他 agent 发消息：点对点（按角色）、广播（"all"）、回 main（"main"）；两种投递：notice（只显示）/ directive（触发行动）。

### 11.2 何时调用

- 需要 agent 间协作、通知、纠偏（角色 agent 对 worker 的纠偏走 msg，不走 steer）；
- 开会：directive 广播到 ≥2 显式角色 → 会议模式（见 CH16）；
- 向 main 汇报。

### 11.3 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `targets` | string[] | 角色名数组 / `"all"` / `"main"` |
| `delivery` | "notice" \| "directive" | notice=只显示不打断；directive=触发对方下一回合 |
| `content` | string | 消息内容 |

### 11.4 返回值

- 成功：`✅ 已向 N 个 agent 发送 <delivery>（notice 只显示 / directive 触发行动）`；
- 部分失败：`⚠ 已向 <sent> 个 agent 发送，其中 <failed> 条失败`；
- 无接收者：`⚠ 无在运行的接收者：targets 未命中任何存活 pane 或 running 任务`。

目标解析：presence（实时存活 pane）→ 回退 running 任务。

### 11.5 notice vs directive

| delivery | 效果 | 适用 |
|---|---|---|
| `notice` | 只显示一行，不打断对方 | 通知、提醒、广播信息 |
| `directive` | 触发对方**下一回合**（行动） | 要求对方干活、纠偏、开会 |

### 11.6 会议模式触发（详见 CH16）

`delivery: "directive"` + `targets` 含 **≥2 个显式角色**（非 "all"）→ 自动进入会议编排：各回一回合 → main 汇总。**排除 depth-2 worker**。

### 11.7 示例

```jsonc
// 点对点
{ "targets": ["tech-director"], "delivery": "directive", "content": "请评审新 API 契约" }
// 广播全员
{ "targets": ["all"], "delivery": "notice", "content": "构建已通过，继续当前任务" }
// 开会
{ "targets": ["planner", "tech-director", "reviewer"], "delivery": "directive", "content": "议程：确定 M9 范围，各给 2 条意见" }
```

---

## CH12 farm_resume（恢复 aborted）

### 12.1 用途

把**中断（aborted）**的任务从上次对话继续，而不是从头开始。

### 12.2 何时调用

- 任务中断（窗口被关/超时/崩溃）后需要接着干；
- 提示恢复命令 `pi -p --session-dir ... --session ...` 时。

### 12.3 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `taskId` | string | 必须是 **aborted** 状态的任务 |

### 12.4 返回值与规则

- 成功：`✅ 已恢复任务 <taskId8>，将从上次对话继续`（重新入队）；
- 拒绝分型：
  - 未找到：`❌ 未找到任务 <id>`;
  - 非 aborted（failed/cancelled）：拒绝并引导**重新派发**;
  - 超期：`❌ 会话已被回收，无法恢复`（>7d GC 窗口）；
  - 跨 owner：拒绝（只能恢复本 owner 派发的任务）。

### 12.5 示例

```jsonc
{ "taskId": "1a2b3c4d5e6f" }
```

---

## CH13 farm_status（查询）

### 13.1 用途

查看任务列表（台账）/ 单任务详情 / 按状态过滤。**纯查询、零副作用**。

### 13.2 何时调用

- 调度决策前（看 farm 占用/排队情况）；
- 查排队位置、任务终态；
- 拿恢复命令（aborted 详情里给 `恢复命令:` 可直接执行）；
- 审计/对账。

### 13.3 三种形态

**无参 = 5 列台账**：

```
taskId   role         status   attempts 耗时
1a2b3c4d tech-director 运行中    0/2      3.2s
...
共 N 个任务 · 会话保留 7 天
```

**taskId 参数 = 详情**（完整 taskId / role / form / status / attempts / nextAttemptAt / 耗时 / startedAt / updatedAt / exitCode / usage / 恢复命令）。

**status 参数 = 过滤**：`queued` / `running` / `timeout` / `done` / `aborted` / `failed` / `cancelled`。

### 13.4 示例

```jsonc
// 全量台账
{}
// 单任务详情
{ "taskId": "1a2b3c4d5e6f" }
// 只看运行中
{ "status": "running" }
// 只看已完成
{ "status": "done" }
```

---

## CH14 状态面板（setWidget，自动）

### 14.1 用途

主会话**常驻状态面板**（编辑器上方），1s 刷新，只读展示农场全景。

### 14.2 面板内容

7 列：`taskId / role / status / attempts / 耗时 / usage(费用) / 投递态`；底部计数行（共 N 个任务 · 存活 M · 会话保留 7 天 · 合计成本）。

| 特性 | 值 |
|---|---|
| 刷新 | 1s（内容变化才重绘） |
| 显示条数 | 最近 50 条（recentN） |
| 运行中成本 | 「—」（终态后才有值） |
| 占位价提示 | pricing.json 缺失/非法时提示「⚠️ 成本为占位价」 |

### 14.3 面板与工具的分工

面板**只读展示**；一切操作仍走五个工具（spawn/steer/msg/farm_resume/farm_status）。面板是 main-only（pane 侧不注册）。
