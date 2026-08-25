// src/task-core/queue.ts
// 队列循环核心：并发上限（默认 3 可配）/ 重试退避（nextAttemptAt 落盘）/ deadline 仲裁。
//
// 依据：.scratch/m1b-task-core/issues/03-queue.md 已批准方案 + .scratch/m2-background-mode/
//   issues/03-taskcore-patch.md + docs-internal/PRD-v3.md §13.3（M2 修订版迁移表）：
//   - Executor{spawn/steer/kill} 接口本模块声明（M2 真实现与 04-steer 复用）；
//     spawn(task) → Promise<{paneId, sessionDir}>（M2 签名扩展）；
//   - tick(input)→TickOutput 纯函数：clock=now 参数注入，零 I/O、零副作用；
//   - Queue{store, executor, maxConcurrency=3, now, owner, allocateSessionDir}；
//   - step(options?) = scanTasks(全局快照) → 本 owner 过滤 → 逐个 readStatusSignal
//     → tick → 解释执行；顶层 try/catch（spawn 抛错不崩 ticker）；
//     400ms 轮询循环归调用方（本模块无 setTimeout/sleep、无循环）。
//
// tick 三阶段（同一快照）：
//   1) 收集：running 数 = 本 owner running（per-farm 独立并发预算，BE#1）；
//      queued 候选按 createdAt↑、taskId 排序；
//   2) 决策：每任务 ≤1 条（dequeue/paneDone/paneAborted/deadline/retry/exhausted）；
//      决策序列序：pass A（running 仲裁，taskId 序）→ pass B（timeout 迟到信号
//      修正 + 重试/用尽，taskId 序）→ pass C（queued 出队，createdAt↑/taskId 序）；
//   3) 解释执行归 Queue.step：transition → writeTask 落盘 status/updatedAt/
//      startedAt/attempts/nextAttemptAt/result（每次 transition 后自行持久化并
//      bump updatedAt；writeTask 动作仅挂 enqueue 行、本模块不消费）→
//     acquireSlot→spawn / killPane→kill / consumeSignal→removeStatusSignal /
//     notifyMain→notifications。
//
// 仲裁：同一 tick 先查 pane 信号、后查 paneGone 注入、再查 deadline
//   （pane 信号优先）；done 与 aborted 信号俱在时 store.readStatusSignal 已裁定
//   done 胜（02-store）；信号读取带 since=startedAt 陈旧过滤（旧 attempt 残留
//   aborted 不误判 paneAborted，同 attempt 迟到 done 不受影响）；timeout 后
//   tick 仍查信号（迟到 done/aborted 修正，不重跑）；pass A/B 均按快照内
//   status 判定（paneGone 仅对 running 生效，防 IllegalTransitionError）。
//
// 范围 pin（票 03 已批准方案 + M2 补丁实现解释）：
//   - 退避落盘：nextAttemptAt 由 retry 行写盘（states 权威计算 backoffSecs）、
//     tick 出队判据读盘；废除内存 backoffs Map，进程重启不退避归零。
//   - retry 判定按迁移表字面：timeout|failed + attempts<maxAttempts 均发 retry
//     （abandon 来源的 failed 亦重试）。attempts 用尽：timeout → exhausted →
//     failed 终态（通知一次）；failed+用尽 = 终态跳过、不重复通知（该任务进入
//     failed 时已通知，或 abandon 路径的 resumeTimeout 通知由派发方在 abandon
//     时已发——两者覆盖，不留通知缺口）。
//   - spawn 失败：apply 捕获 spawn 抛错 → attempts<maxAttempts 发 spawnFailed
//     （动态 retry：attempts+1、nextAttemptAt、回 queued），用尽发 exhausted →
//     failed + notifyMain；spawn 失败不卡 running。sessionDir 分配失败同口径。
//   - spawn 写回竞态：写回 paneId 前 readTask 复查 status==running——spawn 挂起
//     期间外部写 cancelled（shutdown 双扫）则跳过写回（陈旧 updated 不覆盖
//     cancelled），但已起的 pane 成孤儿 → best-effort kill（镜像写回失败分支，
//     防泄漏；杀不掉不落盘、不阻断外部写者状态）；写回失败 = 孤儿 pane →
//     best-effort kill（spawn 返回值 paneId，record 里可能没有；杀不掉不阻断
//     spawnFailed/exhausted 重试）。
//   - transition 落盘统一走 merge：决策基于 tick 快照，而 spawn 写回
//     paneId/sessionDir 是异步的——快照采集于写回之前时，本 tick 的 transition
//     写盘（done/aborted/timeout/retry 等）会用旧快照 record 覆盖 task 文件，
//     clobber 已落盘的 paneId/sessionDir（探测映射丢失；smoke Case2 实测）。
//     修法：apply/onSpawnError 写盘前 readTask 磁盘最新 record，只合并 spawn
//     身份类字段（payload.spawn.paneId / result.sessionDir / outgoing 缺失时的
//     startedAt）；status/attempts/updatedAt/nextAttemptAt/notifiedAt 等仍以
//     outgoing（决策结果）为准；readTask 失败/不存在则原样写（保持容错）。
//   - Executor.kill 入参 = paneId（killPane 传 record 落盘 paneId，空则跳过）。
//   - dequeue 序列：allocateSessionDir 先落盘（running + startedAt + sessionDir）
//     再 spawn（wrapper env 依赖）；spawn 成功后 paneId/sessionDir 写回 task
//     record（探测映射唯一落盘处）。
//   - owner 过滤（单写者三合一）：Queue.step 只读写本 owner 任务；owner 缺省 =
//     M1b 兼容模式（读写真 owner 的一切记录）；存量记录缺 owner → 只读外务
//     （不决策、不落盘）。并发计数 = 本 owner running（per-farm 独立并发预算，BE#1）。
//   - timeoutSecs=0 = 无超时语义（deadline 永不触发）；deadline 锚点 = updatedAt
//     （dequeue 落盘时刻）+ timeoutSecs*1000。
//   - 空位释放生效于下一 tick（决策基于同一快照：running 数按快照计）。
//   - 零第三方依赖；仅 node: 内置（node:fs/promises + node:path 用于 usage sidecar
//     读）+ 相对 .ts；node 22 type-stripping（禁 enum/namespace/构造器参数属性，
//     本文件均未使用）。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { transition } from "./states.ts";
import type { TaskStatus, TransitionCtx } from "./states.ts";
import type { StatusSignal, TaskRecord, TaskStore } from "./store.ts";

/** usage sidecar 落盘形状（wrapper 写、Queue/probe 读） */
export interface UsageSidecar {
  model: string;
  inputTokens: number;
  outputTokens: number;
  updatedAt: number;
}

/** usage sidecar 文件解析（读侧容错）：模型/两 token 字段形状合法才认，否则 null。 */
export function parseUsageSidecar(raw: string): UsageSidecar | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    const model = o["model"];
    const input = o["inputTokens"];
    const output = o["outputTokens"];
    const updatedAt = o["updatedAt"];
    if (typeof model !== "string") return null;
    if (typeof input !== "number" || !Number.isFinite(input)) return null;
    if (typeof output !== "number" || !Number.isFinite(output)) return null;
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
    return { model, inputTokens: input, outputTokens: output, updatedAt };
  } catch {
    return null;
  }
}

/** Executor 注入边界：task-core 唯一外部依赖（M2 真实现与 04-steer 复用）。 */
export interface Executor {
  /** 起 pane 跑任务：收完整落盘 record（status=running）；返回 paneId/sessionDir 写回 task record */
  spawn(task: TaskRecord): Promise<{ paneId: string; sessionDir: string }>;
  /** 向 pane 投递 steer（04-steer 复用；M1b 队列不调用） */
  steer(taskId: string, content: string): Promise<void>;
  /**
   * 杀掉 pane（入参 = paneId 字符串）：
   * - killPane 动作：传 record 落盘 paneId（重跑前杀旧 pane；paneId 空跳过）；
   * - 写回失败孤儿 pane：传 spawn 返回值（paneId 未落盘也能杀）。
   * 杀不掉由调用方 best-effort 吸收，不阻断重试逻辑。
   */
  kill(paneId: string): Promise<void>;
}

/** tick 决策事件集（TransitionEvent 子集；spawnFailed 由 apply 的 spawn 抛错路径发出）。 */
export type TickEvent =
  | "dequeue"
  | "paneDone"
  | "paneAborted"
  | "deadline"
  | "retry"
  | "exhausted"
  | "spawnFailed";

export interface TickDecision {
  taskId: string;
  event: TickEvent;
}

export interface TickInput {
  /** 决策候选快照（本 owner 任务；step 内一次 scanTasks 后过滤）；tick 只读不修改 */
  tasks: readonly TaskRecord[];
  /** taskId → 本 tick 读到的 pane 信号（step 逐个 readStatusSignal） */
  signals: ReadonlyMap<string, StatusSignal>;
  /** pane 消失注入（仅 status==running 生效；经 queue 迁移，不落 status 文件） */
  paneGone: ReadonlySet<string>;
  /** 时钟（epoch ms）：tick 唯一时间来源 */
  now: number;
  /** 并发上限（整数 ≥1） */
  maxConcurrency: number;
  /** 本 owner running 数（per-farm 独立并发预算；BE#1） */
  runningCount: number;
}

export interface TickOutput {
  /** 决策序列：pass A（running 仲裁）→ pass B（迟到修正 + retry/exhausted）→ pass C（dequeue） */
  decisions: TickDecision[];
}

export type NotifyReason = "attemptsExhausted" | "resumeTimeout" | "aborted";

/** notifyMain 动作的落点（step 返回给调用方消费；notifiedAt 落盘归 farm 层）。 */
export interface QueueNotification {
  taskId: string;
  reason: NotifyReason;
}

export interface QueueOptions {
  store: TaskStore;
  executor: Executor;
  /** 并发上限，默认 3；须整数 ≥1 */
  maxConcurrency?: number;
  /** 时钟函数（返回 epoch ms），默认 Date.now；测试注入可变时钟 */
  now?: () => number;
  /**
   * 本进程 owner（pid+启动时间）。配置后 step 只读写真 owner 任务；
   * 缺省/null = M1b 兼容模式（读写真 owner 的一切记录，缺 owner 存量记录仍只读）。
   */
  owner?: string | null;
  /**
   * dequeue 时分配 sessionDir（wrapper env 依赖）：返回后先落盘再 spawn。
   * 缺省 = 沿用 record.result.sessionDir；抛错视同 spawn 失败（spawnFailed 口径）。
   */
  allocateSessionDir?: (task: TaskRecord) => Promise<string>;
}

/** step 可选入参（farm 循环 ticker 注入）。 */
export interface StepOptions {
  /** 本轮探测到 pane 已消失的任务 id（tick 注入 aborted；仅 running 生效，不落 status 文件） */
  paneGone?: readonly string[];
}

export interface StepReport {
  /** 本 tick 时钟读数 */
  now: number;
  /** 本 tick 决策序列（tick 输出 + spawn 抛错路径的 spawnFailed/exhausted） */
  decisions: readonly TickDecision[];
  /** notifyMain 落点 */
  notifications: readonly QueueNotification[];
}

/**
 * 队列循环纯决策函数（零 I/O、零副作用）。
 * 三阶段（同一快照）：收集 → 决策 → 输出（解释执行归 Queue.step）。
 * 决策序列序：pass A（running 仲裁：pane 信号 → paneGone → deadline）→
 * pass B（timeout 迟到信号修正 + retry/用尽）→ pass C（queued 出队，
 * 读 task.nextAttemptAt 落盘判据）。
 */
export function tick(input: TickInput): TickOutput {
  const { tasks, signals, paneGone, now, maxConcurrency, runningCount } = input;
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("tick: now must be a finite number (epoch ms)");
  }
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new TypeError("tick: maxConcurrency must be an integer >= 1");
  }
  if (!Number.isInteger(runningCount) || runningCount < 0) {
    throw new TypeError("tick: runningCount must be an integer >= 0");
  }
  const decisions: TickDecision[] = [];

  // pass A：running 仲裁（先查 pane 信号、再查 paneGone 注入、后查 deadline——
  // pane 侧事实优先；paneGone 仅对 running 生效 = guard 防 IllegalTransitionError）
  for (const task of tasks) {
    if (task.status !== "running") continue;
    const signal = signals.get(task.taskId) ?? null;
    if (signal !== null) {
      decisions.push({
        taskId: task.taskId,
        event: signal.kind === "done" ? "paneDone" : "paneAborted",
      });
    } else if (paneGone.has(task.taskId)) {
      decisions.push({ taskId: task.taskId, event: "paneAborted" });
    } else if (deadlinePassed(task, now)) {
      decisions.push({ taskId: task.taskId, event: "deadline" });
    }
  }

  // pass B：timeout 迟到信号修正（done/aborted 信号优先于 retry，不重跑）→
  // retry/用尽；failed 无信号检查（迁移表字面）
  for (const task of tasks) {
    if (task.status === "timeout") {
      const signal = signals.get(task.taskId) ?? null;
      if (signal !== null) {
        decisions.push({
          taskId: task.taskId,
          event: signal.kind === "done" ? "paneDone" : "paneAborted",
        });
      } else if (task.attempts < task.maxAttempts) {
        decisions.push({ taskId: task.taskId, event: "retry" });
      } else {
        decisions.push({ taskId: task.taskId, event: "exhausted" });
      }
      continue;
    }
    if (task.status === "failed" && task.attempts < task.maxAttempts) {
      decisions.push({ taskId: task.taskId, event: "retry" });
    }
    // failed + attempts 用尽 → 终态跳过（exhausted 通知已于进入 failed 时发出；
    // abandon 路径的 resumeTimeout 通知由派发方在 abandon 时已发）
  }

  // pass C：queued 候选按 createdAt↑、taskId 排序出队（并发占用 = 本 owner
  // running；nextAttemptAt 落盘判据：未到点不出队）。
  // M3 翻转后兜底：depth≥3 候选被过滤（depth-2 已恢复出队）——record 停留
  // queued；被过滤候选不占并发位（freeSlots 只计真正出队者）。
  let freeSlots = maxConcurrency - runningCount;
  const candidates = tasks
    .filter(
      (task) =>
        task.status === "queued" &&
        backoffElapsed(task, now) &&
        !isDepthGated(task),
    )
    .slice()
    .sort(compareByCreatedAtThenId);
  for (const task of candidates) {
    if (freeSlots <= 0) break;
    decisions.push({ taskId: task.taskId, event: "dequeue" });
    freeSlots -= 1;
  }
  return { decisions };
}

/** 队列循环（时钟/Executor/owner/allocateSessionDir 注入；循环归调用方）。 */
export class Queue {
  readonly store: TaskStore;
  readonly executor: Executor;
  readonly maxConcurrency: number;
  readonly owner: string | null;
  private readonly clock: () => number;
  private readonly allocate: ((task: TaskRecord) => Promise<string>) | null;

  constructor(options: QueueOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Queue: options must be an object");
    }
    const { store, executor, maxConcurrency = 3, now, owner = null, allocateSessionDir } = options;
    if (store === undefined || store === null) {
      throw new TypeError("Queue: store is required");
    }
    if (executor === undefined || executor === null) {
      throw new TypeError("Queue: executor is required");
    }
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new TypeError("Queue: maxConcurrency must be an integer >= 1");
    }
    if (now !== undefined && typeof now !== "function") {
      throw new TypeError("Queue: now must be a function returning epoch ms");
    }
    if (owner !== undefined && owner !== null && typeof owner !== "string") {
      throw new TypeError("Queue: owner must be a string or null");
    }
    if (allocateSessionDir !== undefined && typeof allocateSessionDir !== "function") {
      throw new TypeError("Queue: allocateSessionDir must be a function");
    }
    this.store = store;
    this.executor = executor;
    this.maxConcurrency = maxConcurrency;
    this.owner = owner;
    this.clock = now ?? (() => Date.now());
    this.allocate = allocateSessionDir ?? null;
  }

  /**
   * 一轮队列处理（400ms 循环归调用方）：
   * 全局快照 scanTasks(null)（快照 + GC 同源）→ 本 owner 过滤（并发计数只计本 owner）→
   * 逐个 readStatusSignal（since=startedAt：旧 attempt 残留信号按陈旧忽略，
   * 同 attempt 迟到 done 不受影响）→ tick（纯决策）→ 逐条解释执行：
   * transition → writeTask 落盘（status/updatedAt/startedAt/attempts/
   * nextAttemptAt/result）→ acquireSlot→spawn / killPane→kill /
   * consumeSignal→removeStatusSignal / notifyMain→notifications。
   * 顶层 try/catch：任何未预期错误（store I/O、executor 抛错）不崩 ticker；
   * 已完成的决策与落盘保留，本轮其余决策留待下一 tick 重试。
   */
  async step(options?: StepOptions): Promise<StepReport> {
    const now = this.clock();
    const decisions: TickDecision[] = [];
    const notifications: QueueNotification[] = [];
    try {
      const paneGone = new Set(Array.isArray(options?.paneGone) ? options.paneGone : []);
      const all = await this.store.scanTasks(null);
      const own = all.filter((task) => isWritable(task, this.owner));
      const signals = new Map<string, StatusSignal>();
      for (const task of own) {
        const signal = await this.store.readStatusSignal(task.taskId, { since: task.startedAt });
        if (signal !== null) signals.set(task.taskId, signal);
      }
      const output = tick({
        tasks: own,
        signals,
        paneGone,
        now,
        maxConcurrency: this.maxConcurrency,
        runningCount: countTasks(own, "running"),
      });
      const byId = indexById(own);
      for (const decision of output.decisions) {
        const record = byId.get(decision.taskId);
        if (record === undefined) continue; // 与 tick 同一快照，正常不可达（防御）
        // M3 翻转后兜底（双保险第 2 层：tick 过滤漏网时在此拒绝执行）——
        // depth≥3 的 dequeue 不 transition、不 spawn，record 停留 queued。
        if (decision.event === "dequeue" && isDepthGated(record)) continue;
        decisions.push(decision);
        await this.apply(record, decision, signals, now, notifications, decisions);
      }
    } catch {
      // 顶层 try/catch：不崩 ticker（见 step 文档）
    }
    return { now, decisions, notifications };
  }

  /** 解释执行单条决策：transition → 落盘（自行 writeTask）→ 动作映射。 */
  private async apply(
    record: TaskRecord,
    decision: TickDecision,
    signals: ReadonlyMap<string, StatusSignal>,
    now: number,
    notifications: QueueNotification[],
    decisions: TickDecision[],
  ): Promise<void> {
    // transition 落盘统一走 merge：决策基于 tick 快照，spawn 写回 paneId/
    // sessionDir 异步——快照采集于写回之前时，直接落盘会 clobber 已写回的
    // paneId/sessionDir（探测映射丢失）。先 refresh 快照 record 的 spawn 身份
    // 字段，再走 transition（signal/allocate 覆写的 sessionDir 仍胜磁盘值）。
    record = await this.mergeSpawnIdentity(record);
    const ctx: TransitionCtx | undefined =
      decision.event === "retry" || decision.event === "spawnFailed"
        ? { attempts: record.attempts, backoffSecs: record.backoffSecs }
        : undefined;
    const result = transition(record.status, decision.event, ctx);
    const updated: TaskRecord = { ...record, status: result.next, updatedAt: now };
    if (decision.event === "dequeue") updated.startedAt = now; // dequeue 写 startedAt
    // 先补 record 字段（attempts/nextAttemptAt/result/通知），再一次性 writeTask 落盘
    for (const action of result.actions) {
      switch (action.kind) {
        case "retry":
          updated.attempts = action.attempt; // states 权威计算（attempts+1）
          updated.nextAttemptAt = now + action.backoffSecs * 1000; // 退避落盘
          break;
        case "readDoneStatus": {
          const signal = signals.get(record.taskId);
          if (signal !== undefined && signal.kind === "done") {
            updated.result = {
              ...record.result,
              sessionDir: signal.sessionDir,
              exitCode: signal.exitCode,
            };
            // 票 06（FR7）：done 信号同时读 usage sidecar → result.cost（无 sidecar 留 0）。
            const sidecar = await this.readUsageSidecar(
              signal.sessionDir !== "" ? signal.sessionDir : record.result.sessionDir,
              record.taskId,
            );
            if (sidecar !== null) {
              updated.result.cost = {
                model: sidecar.model,
                inputTokens: sidecar.inputTokens,
                outputTokens: sidecar.outputTokens,
              };
            }
          }
          break;
        }
        case "markTimeout":
        case "readAbortedStatus":
          // schema 无超时/中止附加字段：status 本身即标记（writeTask 落盘 status）
          break;
        case "notifyMain":
          notifications.push({ taskId: record.taskId, reason: action.reason });
          break;
        default:
          // writeTask（落盘由本方法承担）/ markCancelled / fillResumeFrom /
          // writeInbox（均派发方/wd 路径，M1b 队列决策集不产生）/
          // killPane / consumeSignal（I/O 阶段执行）→ 忽略
          break;
      }
    }
    await this.store.writeTask(updated);
    // 落盘后解释 I/O 动作（spawn 收完整落盘 record）
    for (const action of result.actions) {
      switch (action.kind) {
        case "consumeSignal":
          // 只消费陈旧信号（mtime < 本 attempt startedAt）：deadline 边界时刻
          // wrapper 恰写入的新 done/aborted 予以保留，下一 tick 迟到修正边接管。
          await this.store.removeStatusSignal(
            record.taskId,
            record.startedAt > 0 ? { beforeMs: record.startedAt } : undefined,
          );
          break;
        case "acquireSlot":
          await this.spawnAttempt(updated, now, notifications, decisions);
          break;
        case "killPane": {
          // 入参 = 落盘 paneId（重跑前杀旧 pane；缺省/空 = 无可杀，跳过）
          const paneId = record.payload.spawn.paneId;
          if (paneId !== "") await this.executor.kill(paneId);
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * acquireSlot 解释：sessionDir 分配 → 先落盘（running + startedAt + sessionDir）
   * → spawn → paneId/sessionDir 写回。spawn 抛错 → 按 attempts 发
   * spawnFailed/exhausted（spawn 失败不卡 running）。
   */
  private async spawnAttempt(
    record: TaskRecord,
    now: number,
    notifications: QueueNotification[],
    decisions: TickDecision[],
  ): Promise<void> {
    const updated: TaskRecord = {
      ...record,
      payload: { ...record.payload, spawn: { ...record.payload.spawn } },
      result: { ...record.result },
    };
    if (this.allocate !== null) {
      try {
        updated.result.sessionDir = await this.allocate(updated);
      } catch {
        // sessionDir 分配失败视同 spawn 失败：先落 running（sessionDir 保持原值）
        await this.store.writeTask(updated);
        await this.onSpawnError(updated, now, notifications, decisions);
        return;
      }
    }
    await this.store.writeTask(updated); // 先落盘再 spawn（wrapper env 依赖 sessionDir）
    try {
      const out = await this.executor.spawn(updated);
      // 返回体容错（M1b 兼容 fake / 未升级执行器）：缺 paneId/sessionDir 用原值
      const paneId =
        out !== null && typeof out === "object" && typeof out.paneId === "string"
          ? out.paneId
          : "";
      const sessionDir =
        out !== null && typeof out === "object" && typeof out.sessionDir === "string" && out.sessionDir !== ""
          ? out.sessionDir
          : updated.result.sessionDir;
      try {
        // 写回前复查：spawn 挂起期间外部写者（shutdown 双扫等）可能已改 status
        // （如 cancelled）——非 running 则跳过写回，防陈旧 updated 覆盖 cancelled。
        const current = await this.store.readTask(updated.taskId);
        if (current === null || current.status !== "running") {
          // 跳过写回 ≠ 跳过清理：spawn 已起的 pane 是孤儿（paneId 未落盘、
          // 探测映射缺失）→ best-effort kill（镜像 catch 分支），防永久泄漏。
          // kill 抛错自身吸收：不落入外层 catch（否则触发 onSpawnError，
          // 会覆盖外部写者落盘的 cancelled）。
          try {
            if (paneId !== "") await this.executor.kill(paneId);
          } catch {
            // kill 抛错不阻断；任务状态归外部写者，本方法不落盘
          }
          return;
        }
        await this.store.writeTask({
          ...updated,
          payload: { ...updated.payload, spawn: { ...updated.payload.spawn, paneId } },
          result: { ...updated.result, sessionDir },
        });
      } catch {
        // 写回失败 = 孤儿 pane（paneId 未落盘，探测映射缺失）：best-effort kill
        // 用 spawn 返回值（record 里没有）；杀不掉不阻断 spawnFailed/exhausted 重试。
        try {
          if (paneId !== "") await this.executor.kill(paneId);
        } catch {
          // kill 抛错不阻断重试落盘
        }
        await this.onSpawnError(updated, now, notifications, decisions);
      }
    } catch {
      await this.onSpawnError(updated, now, notifications, decisions);
    }
  }

  /**
   * spawn 抛错口径（调用方按 attempts 选事件）：
   * attempts<maxAttempts → spawnFailed（running×spawnFailed→queued 动态 retry：
   * attempts+1、nextAttemptAt 落盘）；否则 exhausted → failed 终态 + notifyMain。
   * 均落盘，spawn 失败不卡 running。
   */
  private async onSpawnError(
    running: TaskRecord,
    now: number,
    notifications: QueueNotification[],
    decisions: TickDecision[],
  ): Promise<void> {
    // 与 apply 同口径：transition 落盘前 merge 磁盘最新 spawn 身份字段
    // （spawn 抛错可能晚于快照，期间外部写回的 paneId/sessionDir 不丢）。
    running = await this.mergeSpawnIdentity(running);
    const event: TickEvent = running.attempts < running.maxAttempts ? "spawnFailed" : "exhausted";
    decisions.push({ taskId: running.taskId, event });
    const ctx: TransitionCtx = { attempts: running.attempts, backoffSecs: running.backoffSecs };
    const result = transition("running", event, ctx);
    const updated: TaskRecord = { ...running, status: result.next, updatedAt: now };
    for (const action of result.actions) {
      if (action.kind === "retry") {
        updated.attempts = action.attempt;
        updated.nextAttemptAt = now + action.backoffSecs * 1000;
      } else if (action.kind === "notifyMain") {
        notifications.push({ taskId: running.taskId, reason: action.reason });
      }
    }
    await this.store.writeTask(updated);
    // 落盘后解释 I/O 动作（镜像 apply：running × exhausted 的 killPane 前置杀残留 pane）
    for (const action of result.actions) {
      if (action.kind === "killPane") {
        const paneId = running.payload.spawn.paneId;
        if (paneId !== "") await this.executor.kill(paneId);
      }
    }
  }

  /**
   * transition 落盘统一走 merge：写盘前 readTask 读磁盘最新 record，把 spawn
   * 身份类字段（payload.spawn.paneId / result.sessionDir / outgoing 缺失时的
   * startedAt）合并进 outgoing——spawn 写回 paneId/sessionDir 是异步的，tick
   * 快照可能采集于写回之前，用旧快照 record 直接落盘会 clobber 已落盘的
   * paneId/sessionDir（探测映射丢失）。status/attempts/updatedAt/nextAttemptAt/
   * notifiedAt 等仍以 outgoing（决策结果）为准，不合并。readTask 失败/不存在
   * （null）→ 原样返回 outgoing（保持现有容错，不抛）。
   */
  private async mergeSpawnIdentity(outgoing: TaskRecord): Promise<TaskRecord> {
    try {
      const onDisk = await this.store.readTask(outgoing.taskId);
      if (onDisk === null) return outgoing;
      const merged: TaskRecord = {
        ...outgoing,
        payload: {
          ...outgoing.payload,
          spawn: { ...outgoing.payload.spawn, paneId: onDisk.payload.spawn.paneId },
        },
        result: { ...outgoing.result, sessionDir: onDisk.result.sessionDir },
      };
      if (outgoing.startedAt === undefined) merged.startedAt = onDisk.startedAt;
      return merged;
    } catch {
      return outgoing; // readTask 抛错（防御）：原样写，保持现有容错
    }
  }

  /** 读 usage sidecar：farmRoot = dirname(dirname(sessionDir))（sessions 恒在 FARM_ROOT/sessions 下）。
   *  缺文件/坏 JSON/形状非法 → null（cost 留 0，容错）。读侧容忍 torn（wrapper tmp+mv 原子写）。 */
  private async readUsageSidecar(sessionDir: string, taskId: string): Promise<UsageSidecar | null> {
    if (typeof sessionDir !== "string" || sessionDir === "") return null;
    try {
      const path = join(dirname(dirname(sessionDir)), "usage", `${taskId}.json`);
      return parseUsageSidecar(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  }
}

// ---------- 内部助手 ----------

/** 单写者判定：存量记录缺 owner → 只读外务（不决策、不落盘）；
 *  owner 配置时只写真 owner；缺省 = 对一切有 owner 的记录读写。 */
function isWritable(task: TaskRecord, owner: string | null): boolean {
  if (typeof task.owner !== "string" || task.owner === "") return false;
  return owner === null || owner === task.owner;
}

function indexById(tasks: readonly TaskRecord[]): Map<string, TaskRecord> {
  const map = new Map<string, TaskRecord>();
  for (const task of tasks) map.set(task.taskId, task);
  return map;
}

function countTasks(tasks: readonly TaskRecord[], status: TaskStatus): number {
  let n = 0;
  for (const task of tasks) {
    if (task.status === status) n += 1;
  }
  return n;
}

function compareByCreatedAtThenId(a: TaskRecord, b: TaskRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/** 退避判据读盘：task.nextAttemptAt 未到点不出队；缺失/非数按 0（容错，立即出队）。 */
function backoffElapsed(task: TaskRecord, now: number): boolean {
  const nextAttemptAt = task.nextAttemptAt;
  return (
    typeof nextAttemptAt !== "number" || !Number.isFinite(nextAttemptAt) || nextAttemptAt <= now
  );
}

/** M3 翻转后兜底守卫：depth≥3 任务不出队、不 spawn（record 停留 queued）。
 *  depth 口径 1-based（main 直派=1 / 角色 agent 派=2 / depth≥3 无 spawn 工具，纯防御）。
 *  旧记录 depth 缺失/非数 → 不拦（保守放行，不误伤存量）。 */
function isDepthGated(task: TaskRecord): boolean {
  const depth = task.depth;
  return typeof depth === "number" && Number.isFinite(depth) && depth >= 3;
}

/** deadline 判定：timeoutSecs>0 才有超时语义；锚点 = updatedAt（dequeue 落盘时刻）。 */
function deadlinePassed(task: TaskRecord, now: number): boolean {
  return task.timeoutSecs > 0 && now >= task.updatedAt + task.timeoutSecs * 1000;
}
