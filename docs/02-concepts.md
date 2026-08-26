# 第二部 · 核心概念：层级、状态与数据（CH4–8）

> 读者：👤+🤖 双读者（CH8 为高级章节）
> 本部分读完你能：理解 agent 团队的三层结构、任务生命周期、工作区隔离、并发/成本模型。**AI agent 读者建议精读本章后进入第三部工具参考。**

---

## CH4 三层级体系

### 4.1 三层定义

| 层级 | 位置 | UI 形态 | 权限 | 人设来源 | 能否再派发 |
|---|---|---|---|---|---|
| **main 主会话** | 你的 pi 会话 | 主界面 + 常驻状态面板 | 全部 + 唯一调度入口 | — | 派角色 agent（depth 1） |
| **角色 agent**（depth 1） | WezTerm pane | 完整 TUI | 与 main 同等 | `~/.pi/agent/agents/<name>.md` | 派 worker（depth 2） |
| **worker**（depth 2） | WezTerm pane | B 形态状态窗口 + 背后 `pi -p` 无头跑 | 无 spawn 工具 | 继承/指示 | **不能再派** |

> **铁律**：层级封顶——worker 不能再往下派；main 是唯一调度入口。worker 也不能参与会议广播（深度过滤，见 4.3）。

### 4.2 form 参数：tui / worker

`form` 是**显示形态**（与角色名 worker **正交**）：

| form | 形态 | 适用场景 |
|---|---|---|
| `"tui"`（默认） | 完整交互式 TUI pane | 交互型角色、需要完整工具与对话 |
| `"worker"` | 自定义状态窗口（pane 内 ANSI 渲染器 + 背后无头 `pi -p`） | 纯执行/批处理，更轻量 |

> ⚠️ **depth≥2 的任务强制 `form:"worker"`**（忽略入参 form）。main 直派可自由选择；角色 agent 派的 worker 恒为 B 形态。

### 4.3 深度过滤规则（C9）

- 会议广播（msg directive）**排除 depth-2 worker**——只有角色 agent（depth 1）与会；
- 读侧有 depthCap 兜底防御；
- AI agent 读者须知：**worker 不能开会、不能再派、收不到会议广播**。

### 4.4 agent 参数（人设枚举）

`spawn_visible_agent` 的 `agent` 参数是**人设枚举名**，来自 `~/.pi/agent/agents/*.md`（文件名 = 角色名，内容为 YAML frontmatter + 人设正文）。当前仓库示例：

`docs-sync` · `e2e-tester` · `git-specialist` · `planner` · `reviewer` · `scout` · `tech-director` · `worker`

- 非法角色名 → 工具拒绝并列出可用列表；
- 无人设可用 → 提示"放置人设文件后 /reload"；
- 自定义人设：在 `~/.pi/agent/agents/` 新建 `<name>.md`（frontmatter 含 `name` / `description` / 可选 `tools`）后 `/reload` 即可。

---

## CH5 任务状态机与队列

### 5.1 七态流转

```
queued ──出队──▶ running ──pane done──▶ done
  ▲        ▲        │── pane aborted ──▶ aborted（终态；resume 可重入队）
  │        │        │── deadline 到期（无 pane 信号）──▶ timeout ──重试用尽──▶ failed
  │        │        │── spawn 失败 ──▶ queued（attempts<max）/ failed（用尽）
  │        │        │── 取消 ──▶ cancelled
  │        │        └── steer ─▶ running（投递态在 inbox 推进，不换状态）
  │        │
  │        ├── failed ──重试（attempts<max，退避 5s/30s）──▶ queued
  │        └── timeout ──迟到 pane done/aborted 信号──▶ done / aborted（不重跑）
  │
  └── 取消 ──▶ cancelled
```

### 5.2 状态表

| 状态 | 含义 | 写入者 | 对应文件 |
|---|---|---|---|
| `queued` | 排队中 | 派发方/队列 | `tasks/<id>.json` |
| `running` | 运行中 | 队列循环 | `tasks/<id>.json` |
| `done` | 完成 | wrapper | `status/<id>.done` |
| `aborted` | 中断（可恢复） | wrapper | `status/<id>.aborted` |
| `failed` | 重试用尽/不可恢复 | 队列 | `tasks/<id>.json` |
| `timeout` | 单次尝试超时 | 队列 | `tasks/<id>.json` |
| `cancelled` | 取消 | 队列 | `tasks/<id>.json` |

> farm_status / spawn 返回值里的 `status` 字段直接对应此七态。

### 5.3 队列机制

| 项 | 值 |
|---|---|
| 并发上限 | **3**（默认） |
| 超出行为 | 自动排队，返回「已排队，位置 N」 |
| 最大尝试次数 | 2（`maxAttempts`） |
| 退避 | 5s → 30s |
| 单次尝试超时 | `timeout_secs`（默认 600s，可配） |

### 5.4 aborted vs cancelled vs failed（重要区分）

| 状态 | 可恢复？ | 说明 |
|---|---|---|
| `aborted` | ✅ 唯一可恢复 | `farm_resume <taskId>` 从上次对话继续（≤7d 窗口） |
| `failed` | ❌ | spawn 用尽/不可恢复，重新派发 |
| `cancelled` | ❌ | 用户主动取消，重新派发 |
| `timeout` | 视情况 | per-attempt 超时；迟到信号可修正为 done/aborted |

---

## CH6 工作区隔离与数据布局

### 6.1 workspaceId 生成规则

```
workspaceId = sha256(realpath(cwd)) 前 12 hex
FARM_ROOT    = ~/.pi-agent-teams/<workspaceId>/
GLOBAL_ROOT  = ~/.pi-agent-teams/   （全局：pricing.json / config.json）
```

- 解析优先级：env `PI_AGENT_TEAMS_ROOT`（spawn 链显式传递）> cwd 派生 > 回退 home；
- **同一项目**（同一 cwd）多次开会话共享同一 farm；**不同项目互不干扰**（任务/状态/消息互不可见）；
- 删除任务数据 = 清空 `~/.pi-agent-teams/<workspaceId>/` 目录（清空 task list 的操作方式）。

### 6.2 单写者矩阵（调试时判断文件可信度）

| 文件 | 谁写 | 谁读 |
|---|---|---|
| `tasks/<taskId>.json` | 所属队列（owner 进程） | 所有 |
| `status/<id>.done \| .aborted` | wrapper | 队列/面板 |
| `status/<id>.result` | wrapper | sync 等待器 |
| `status/<id>.consumed` | sync 等待器 | wireFarm 去重 |
| `usage/<taskId>.json` | wrapper | 面板/队列 |
| `inbox/<paneId>/` | 发送方 | 收信 pane |
| `presence/<taskId>.json` | 各自 pane 进程 | msg 寻址 |

---

## CH7 并发、超时与成本

### 7.1 并发与超时

- 并发上限默认 **3**，超出排队（CH5.3）；
- `timeout_secs` 是**每尝试**超时（默认 600s）；
- **`sync: true` 的回合挂起语义**（AI agent 必知）：等待期间**不能调用其他工具**（回合挂起）——满载时建议用异步 + `farm_status`，不要用 sync 等一个排队的任务。

### 7.2 成本模型

| 项 | 说明 |
|---|---|
| 数据源 | usage sidecar（wrapper 从 session jsonl 提取，终态后写） |
| 换算 | token × 价目表（`~/.pi-agent-teams/pricing.json`，用户可配，**插件只读不写**） |
| 运行中 | 成本显示「—」（无实时数据，事后估算） |
| 终态 | `result.cost`（model / inputTokens / outputTokens） |
| 缺省 | pricing.json 缺失/非法 → 回退内置默认价目表（面板会提示"成本为占位价"） |

---

## CH8 数据协议（高级读者）

> 本章为**调试/深度集成**用；普通使用无需阅读。仅描述文件协议，不是源码阅读。

### 8.1 任务记录 `tasks/<taskId>.json`

```json
{
  "taskId": "uuid", "type": "spawn|steer|msg|schedule",
  "parentId": "uuid|null", "depth": 1,
  "status": "queued|running|done|aborted|failed|timeout|cancelled",
  "owner": "pid+启动时间", "createdAt": 0, "updatedAt": 0,
  "startedAt": 0, "nextAttemptAt": 0, "notifiedAt": 0,
  "timeoutSecs": 0, "attempts": 0, "maxAttempts": 2, "backoffSecs": [5, 30],
  "payload": {
    "spawn": { "role": "", "prompt": "", "cwd": "", "resumeFrom": null, "paneId": "", "form": "tui|worker" },
    "steer": { "targetTaskId": "", "content": "" },
    "msg":   { "targets": ["role|all"], "delivery": "notice|directive", "content": "" },
    "schedule": { "mode": "once|interval|cron", "cron": "", "intervalSecs": 0, "onceAt": 0, "lastRun": 0, "nextRun": 0, "firedTaskIds": [] }
  },
  "result": { "sessionDir": "", "exitCode": null, "cost": { "model": "", "inputTokens": 0, "outputTokens": 0 } }
}
```

### 8.2 结果与去重（为什么不会收到重复 farm.done）

- `status/<id>.result`：wrapper 在完成路径截写 **{exitCode, sessionDir, summary, sha256, writtenAt}**，其中 summary 是最终答案全文（8KB 上限），sha256 是会话 jsonl 全文哈希（用于对拍校验）；
- `status/<id>.consumed`：sync 等待器取回结果后原子创建；wireFarm 的 deliver 出口查它 → **已消费的终态不发 farm.done**（flush + session_start replay 双路径共享此出口）；
- 结论：**一个任务只产生一次完成通知**，sync 取回与异步通知互斥，不会重复。

### 8.3 inbox 消息 `inbox/<paneId>/<msgId>.json`

```json
{
  "msgId": "uuid", "type": "steer|msg",
  "from": "main|paneId", "to": "paneId",
  "delivery": "notice|directive", "content": "",
  "status": "pending|delivered|read", "ts": 0
}
```

- `to` 恒为具体 paneId（`all` 只在 msg 工具入参出现，写侧 fan-out 展开为 N 条）；
- 投递语义 at-most-once：advance 到 delivered 在 sink 前、advance 到 read 在 sink 成功后；sink 抛错停留 delivered 不重投，24h GC 兜底。

### 8.4 presence 心跳 `presence/<taskId>.json`

每个 pane 进程每 3s 原子写 `{taskId, paneId, role, depth, pid, heartbeatAt}`（tmp+mv，0600）。msg 工具用它做 role→paneId 映射；缺失时回退扫描 running 任务。
