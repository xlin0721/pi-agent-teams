# 第四部 · 工作流、运维与内部机制（CH15–20）

> 读者：👤+🤖 双读者
> 本部分读完你能：走通典型工作流、开会、排障、配置成本、知晓边界；AI agent 可参考 CH20 决策卡快速选工具。

---

## CH15 典型工作流（人类剧本）

### 15.1 六步闭环剧本

| 步骤 | 场景 | 操作 | 预期输出 |
|---|---|---|---|
| 1 | 并行派发 | 对 pi 说"派 3 个 agent 并行：产品、前端、后端主管" | 3 个任务 ack（taskId + 排队位置）；右侧弹 3 个 pane |
| 2 | 观察纠偏 | 看到前端跑偏 | `steer 2b3c4d — 守住 M7 范围，不做 reflow` |
| 3 | 中期站会 | 需要同步进度 | `msg` directive 广播议程（≥2 角色 → 自动开会） |
| 4 | 查终态 | 等结果 | `farm_status`（5 列台账）/ 面板 |
| 5 | 意外中断 | 窗口被关/超时 | `farm_resume <taskId>` 接着干 |
| 6 | 对账 | 收尾 | 面板成本列 / `farm_status <taskId>` 详情 usage |

### 15.2 完整示例对话

```text
你:  spawn 3 agents in parallel — one product lead, one frontend lead, one backend lead.
     I'll keep chatting here while they work.

pi:  ✅ task 1a2b3c (product-lead) queued → running
     ✅ task 2b3c4d (frontend-lead) queued → running
     ✅ task 3c4d5e (backend-lead) queued → running
     (右侧出现 3 个 pane，各自实时显示工作)

你:  (看到前端跑偏) steer 2b3c4d — stick to the M7 scope, no reflow.

pi:  ✅ 已向 2b3c4d 发送 steer（其当前工具跑完后生效）

你:  (开站会) msg targets=["planner","tech-director","reviewer"]
     delivery="directive" content="议程：对齐 M9 范围，每人给 2 条意见"

pi:  ✅ 已向 3 个 agent 发送 directive
     ... (各 agent 回复一回合，main 汇总一回合)

你:  farm_status

pi:  5 列台账：taskId / role / status / attempts / 耗时
```

---

## CH16 会议模式

### 16.1 触发条件

`msg` 工具：`delivery: "directive"` + `targets` 含 **≥2 个显式角色**（不是 "all"）→ 自动进入会议编排。

### 16.2 过程

```
main 广播议程（directive）→ 受邀角色各回一回合（记录回复）
   → 全体已回 / 120s 超时弃权 → main 汇总一回合（farm.meeting 通知）
```

| 特性 | 值 |
|---|---|
| 超时弃权 | 120s（未回者记弃权，不阻塞） |
| 参会者 | depth-1 角色 agent（**排除 depth-2 worker**） |
| 汇总 | main 合成一份含全部回复的结论 |
| 幂等 | 关轮后迟到回复不纳入；新广播替换旧轮 |

### 16.3 与 msg 的关系

会议**不是独立工具**——它是 directive 广播的聚合行为（编排 + 汇总），零新增机制。不开会时，msg directive 广播就是普通广播。

---

## CH17 降级链与故障排查

### 17.1 三级降级链

| 级别 | 触发 | 行为 |
|---|---|---|
| **L0** | WezTerm 全能力（`wezterm cli list` 成功且有 panes） | 全功能可用 |
| **L1** | WezTerm GUI/mux 连接失败（全 mux 级，同窗口所有 tab 受影响） | 拒绝派发 + 明示 + 引导内置 subagent；任务不落盘 |
| **L2** | 非 WezTerm 环境（`TERM_PROGRAM` 非 WezTerm） | 启动警告 + 拒绝派发 + 引导内置 subagent |

**铁律：任务永不静默丢失**——拒绝派发时任务不落盘、有明确文案，绝不假装成功。

### 17.2 常见问题表

| 症状 | 可能原因 | 解法 |
|---|---|---|
| pane 不出现 | L1/L2 降级、wezterm cli 不可达 | 恢复 WezTerm / 在 WezTerm 中运行 pi |
| spawn 报"无法派发" | 降级门拦截 | 按文案指引恢复环境，或改用内置 subagent |
| steer 看似无响应 | 回合边界语义（当前工具未跑完） | 等下一回合；确认目标 running |
| sync 长时间无返回 | 排队中 / 超时未设 | 查 `farm_status`；调 `wait_timeout_secs`（上限 600） |
| 恢复报"会话已被回收" | 超过 7d GC 窗口 | 无法恢复，重新派发 |
| 恢复报"不是 aborted" | failed/cancelled 不支持恢复 | 重新派发 |
| 面板成本为占位价 | pricing.json 缺失/非法 | 编辑 `~/.pi-agent-teams/pricing.json`（见 CH18） |
| 面板窄屏拥挤 | 屏幕太窄 | `wezterm cli zoom-pane --pane-id <id>` 手动放大 |

### 17.3 排查命令速查

```bash
wezterm cli --no-auto-start list          # 底座是否可达（L0/L1）
farm_status                               # 全量台账（排队/运行/终态）
farm_status <taskId>                      # 单任务详情（含恢复命令）
ls ~/.pi-agent-teams/<wsId>/tasks/        # 任务文件（直接查状态）
cat ~/.pi-agent-teams/<wsId>/status/<id>.done   # 终态信号
```

---

## CH18 配置

### 18.1 pricing.json（成本价目表）

位置：`~/.pi-agent-teams/pricing.json`（全局，**插件只读不写**，用户外部编辑）。

```json
{
  "currency": "USD",
  "per": 1000000,
  "models": {
    "claude-sonnet-4-5": { "input": 3.0, "output": 15.0 },
    "claude-opus-4-1": { "input": 15.0, "output": 75.0 },
    "gpt-4o": { "input": 2.5, "output": 10.0 },
    "*": { "input": 1.0, "output": 5.0 }
  }
}
```

规则：

- `per` = token 基数（1000000 = 每 1M token）；单价 = 每 `per` token 的货币额；
- 模型键精确匹配 → 用该键单价；否则 `"*"` 兜底 → 否则未知模型显「—」；
- `currency` 展示符号：USD→`$`、CNY→`¥`，其余「币种码 + 空格」前缀；
- pricing.json 缺失/非法 → 回退内置默认价目表（面板提示占位价）。

**校准流程**：

1. 查 `~/.pi-agent-teams/<wsId>/usage/<taskId>.json` 的 `model` 字段（或 done 任务 `tasks/<id>.json` 的 `result.cost.model`）；
2. 对照厂商现价填写 `pricing.json`；
3. 插件下次读盘自动生效（无需重启）。

### 18.2 人设文件

`~/.pi/agent/agents/<name>.md`：YAML frontmatter（`name` / `description` / 可选 `tools`）+ 人设正文。新增人设后 `/reload` 即可在 `agent` 参数中选用。

### 18.3 其他默认值（源码常量，暂不可配）

| 项 | 默认 |
|---|---|
| 并发上限 | 3 |
| 最大尝试次数 | 2（退避 5s/30s） |
| 单尝试超时 | 600s |
| sync 等待超时 | 120s（上限 600s） |
| 面板显示条数 | 50 |

---

## CH19 已知限制

| 限制 | 说明 |
|---|---|
| 单窗口单 farm | 多农场 = 多 tab 为远期路线图（M7 锁定） |
| 网格不 reflow | 落点只在 spawn 时刻尽力平衡，之后不跟踪 |
| 运行中成本「—」 | usage 仅终态后写（FR7 事后估算） |
| 未知模型「—」 | 无匹配 model 键且无 `"*"` 兜底 → 显「—」 |
| 定时调度未做 | M5/M6 defer（schedule 解析器预留、无 ticker） |
| 跨平台不做 | macOS + WezTerm 单目标（ADR-0001） |
| steer 非硬中断 | 官方无 kill API，长工具只能等它跑完这轮 |
| 会话隔离 bug（B 方案） | 已登记未开（跨会话数据隔离的已知缺陷） |
| 窄屏 | 降级感知未做；可 zoom-pane 手动缓解 |

---

## CH20 AI agent 决策卡（附录）

### 20.1 条件 → 工具

| 条件 | 工具/动作 |
|---|---|
| 需要并行派发且不阻塞主会话 | `spawn_visible_agent`（默认异步） |
| 需要立即拿到单任务结果 | `spawn_visible_agent(..., sync: true)`，或内置 subagent |
| 运行中的 agent 跑偏 | `steer`（先 `farm_status` 确认 running） |
| 需要全员广播 / 开会 | `msg targets=["all"]`（notice 通知 / directive 行动） |
| 需要多角色开讨论会 | `msg targets=[≥2 角色] delivery="directive"` |
| 任务 aborted 需要接着干 | `farm_resume` |
| 任何时刻查状态/排队/恢复命令 | `farm_status` |
| 环境降级（L1/L2） | 改用内置 subagent 工具 |
| 收到 farm.done 前 | **不得假设结果**；用 `farm_status` 确认或等待通知 |

### 20.2 术语速查

| 术语 | 含义 |
|---|---|
| taskId | 任务唯一标识（工具返回，不可猜） |
| farm.done | 异步完成通知（customType，triggerTurn） |
| depth | main=0 / 角色 agent=1 / worker=2 |
| B 形态 | worker 的显示形态（状态窗口 + 背后无头 pi） |
| 回合边界 | steer 生效的时机（当前轮工具跑完后） |
| consumed | sync 取回后的去重标记（保证单次通知） |

### 20.3 通用约定回顾

1. 5 工具恒定：`spawn_visible_agent` / `steer` / `msg` / `farm_resume` / `farm_status`；
2. farm.done 通知到达前不得编造结果；
3. 任务永不静默丢失（降级必拒派、必引导）；
4. sync 等待期间回合挂起，不能调其他工具；
5. worker 不能开会、不能再派。
