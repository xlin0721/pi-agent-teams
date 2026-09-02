// src/task-core/store.ts
// 任务文件存储（TaskStore）——task record 原子读写 + 一次性快照扫描 + status 信号读取
// + 复查式删除（deleteTask，票 01）。
//
// 依据：issue 02-store 已批准方案 + docs-internal/PRD-v3.md §13.3（task 文件协议 / schema）。
// 关键规则：
//   - 原子写：同目录唯一 tmp（tasks/.<taskId>.<pid>.<randomUUID()>.tmp）→ rename；
//     读侧永远看到完整 JSON（无撕裂）；失败 catch 时 rm force；目录 mkdir recursive。
//   - 单写者：task 文件唯一写者 = 拥有者进程；投递态不进 task 文件（inbox 归 04-steer）。
//   - 轮询：scanTasks 一次性快照；400ms 循环归调用方；禁 fs.watch。
//   - 复查式删除（deleteTask，票 01）：不信任调用方快照，readTask 现读 → 真终态 + 通知守卫
//     重验 → rm force 幂等（镜像 removeStatusSignal read-before-rm 纪律）。
//   - 零依赖：仅 node: 内置模块；node 22 type-stripping（禁 enum/namespace/构造器参数属性）。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// TaskStatus 权威来源：states.ts（状态机单一事实源，7 态 union，§13.3）。
// type-only 导入，零运行时依赖（node 22 type-stripping 下被完整擦除）。
import type { TaskStatus } from "./states.ts";

// 真终态 / 通知守卫纯逻辑（票 02 cleanup.ts）。运行时边仅 store → cleanup 单向：
// cleanup → store 为 import type（type-stripping 下完整擦除）→ 运行时无环。
import { isTrulyTerminal, isCleanableTerminal } from "./cleanup.ts";

// 共享常量（票 09）：deleteTask 缺省守卫窗 = REPLAY_WINDOW_MS（单一事实源 =
// task-core/constants.ts——本地副本常量已删除，与 farm 补发窗同源，杜绝数值漂移）。
import { REPLAY_WINDOW_MS } from "./constants.ts";

/**
 * taskId 安全段校验（writeTask/readTask/readStatusSignal 入口）：防路径逃逸。
 * 空串、单点段（.、..）或含路径分隔符（/ 或 \）→ TypeError；其余字符放行。
 */
function assertSafeTaskId(taskId: string): void {
  if (taskId === "" || taskId === "." || taskId === ".." || taskId.includes("/") || taskId.includes("\\")) {
    throw new TypeError(`invalid taskId: ${JSON.stringify(taskId)}`);
  }
}

export type TaskType = "spawn" | "steer" | "msg" | "schedule";

/** §13.3 schema：payload 四 type 之一 */
export interface SpawnPayload {
  role: string;
  prompt: string;
  cwd: string;
  resumeFrom: string | null;
  /** 形态（票 06）：tui（缺省）= 交互式 TUI pane；worker = B 形态状态窗口。旧记录缺省 tui */
  form?: "tui" | "worker";
  /** split-pane 返回后写回（探测映射唯一落盘处）；旧记录缺省 = "" */
  paneId: string;
}

export interface SteerPayload {
  targetTaskId: string;
  content: string;
}

export interface MsgPayload {
  targets: string[];
  delivery: "notice" | "directive";
  content: string;
}

export interface SchedulePayload {
  mode: "once" | "interval" | "cron";
  cron: string;
  intervalSecs: number;
  onceAt: number;
  lastRun: number;
  nextRun: number;
  firedTaskIds: string[];
}

export interface TaskPayload {
  spawn: SpawnPayload;
  steer: SteerPayload;
  msg: MsgPayload;
  schedule: SchedulePayload;
}

/** cost 只存 token 数与 model（价目换算不在 task-core） */
export interface Cost {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TaskResult {
  sessionDir: string;
  exitCode: number | null;
  cost: Cost;
}

/** task record（§13.3 全字段，无临时扩展字段） */
export interface TaskRecord {
  taskId: string;
  type: TaskType;
  parentId: string | null;
  depth: number;
  status: TaskStatus;
  owner: string;
  createdAt: number;
  updatedAt: number;
  /** dequeue 写（farm_status 耗时列数据源）；旧记录缺失 = 0 */
  startedAt: number;
  /** retry 落盘、tick 出队判据读盘（进程重启不退避归零）；旧记录缺失 = 0 */
  nextAttemptAt: number;
  /** 通知已发时刻（farm 写）；旧记录缺失 = 0/未通知 */
  notifiedAt: number;
  timeoutSecs: number;
  attempts: number;
  maxAttempts: number;
  backoffSecs: number[];
  payload: TaskPayload;
  result: TaskResult;
}

/** readStatusSignal 的返回形状（无信号 → null） */
export type StatusSignal =
  | { kind: "done"; exitCode: number; sessionDir: string }
  | { kind: "aborted" };

/** readStatusSignal 可选入参。 */
export interface ReadStatusSignalOptions {
  /**
   * 信号新鲜度下限（epoch ms，= 当前 attempt 的 startedAt）：
   * 信号文件 mtime < since → 陈旧（旧 attempt 残留，如 retry killPane 后旧
   * wrapper trap 补写的 aborted）→ 按无信号处理，防下一次 attempt 的
   * running 仲裁误判 paneAborted。缺省 / 0 / 非有限数 → 不过滤（兼容旧
   * 调用方与旧落盘记录 startedAt=0）。
   */
  since?: number;
}

/** deleteTask 跳过原因分组（供 03 sweep / 05 farm_cleanup 的 skipped 分组统计复用）。 */
export type DeleteSkipReason = "missing" | "not-terminal" | "unnotified";

/** deleteTask 返回值：判别联合（deleted:true | skipped+reason），无非法状态。 */
export type DeleteTaskResult =
  | { deleted: true }
  | { deleted: false; reason: DeleteSkipReason };

/** deleteTask 可选入参（now / replayWindowMs 可注入，单测确定性；缺省 = Date.now() / 24h）。 */
export interface DeleteTaskOptions {
  now?: number;
  replayWindowMs?: number;
}

/** 解析 status/<id>.done：JSON 且 exitCode 为 number、sessionDir 为 string，否则 null。 */
function parseDoneFile(raw: string): { exitCode: number; sessionDir: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const exitCode = (parsed as { exitCode?: unknown }).exitCode;
    const sessionDir = (parsed as { sessionDir?: unknown }).sessionDir;
    if (typeof exitCode !== "number" || typeof sessionDir !== "string") return null;
    return { exitCode, sessionDir };
  } catch {
    return null;
  }
}

/**
 * 旧落盘记录字段缺失容错（PRD §13.3）：startedAt/nextAttemptAt/notifiedAt 缺 = 0/未通知；
 * payload.spawn.paneId 缺 = ""。owner 不做补写：存量缺 owner → 只读外务（queue 不迁移）。
 * 读侧单一入口处归一化（readTask），写侧原样往返不加不减。
 */
function normalizeLegacy(record: TaskRecord): TaskRecord {
  if (typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)) {
    record.startedAt = 0;
  }
  if (typeof record.nextAttemptAt !== "number" || !Number.isFinite(record.nextAttemptAt)) {
    record.nextAttemptAt = 0;
  }
  if (typeof record.notifiedAt !== "number" || !Number.isFinite(record.notifiedAt)) {
    record.notifiedAt = 0;
  }
  const spawn = record.payload?.spawn;
  if (spawn !== undefined && spawn !== null && typeof spawn === "object") {
    if (typeof spawn.paneId !== "string") spawn.paneId = "";
    if (spawn.form !== "worker") spawn.form = "tui"; // 旧记录缺省 tui（票 06）
  }
  return record;
}

export class TaskStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private tasksDir(): string {
    return join(this.rootDir, "tasks");
  }

  private statusDir(): string {
    return join(this.rootDir, "status");
  }

  private taskPath(taskId: string): string {
    return join(this.tasksDir(), `${taskId}.json`);
  }

  /**
   * 读 task record：缺文件或损坏（不可读 / 坏 JSON / JSON 根非对象）→ null，不抛。
   * 旧落盘记录字段缺失归一化（undefined=0/未通知，paneId=""），owner 缺失保持缺失。
   */
  async readTask(taskId: string): Promise<TaskRecord | null> {
    assertSafeTaskId(taskId);
    try {
      const raw = await readFile(this.taskPath(taskId), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      return normalizeLegacy(parsed as TaskRecord);
    } catch {
      return null;
    }
  }

  /**
   * 原子写 task record（原样往返，不加不减字段）：
   *   1) mkdir tasks recursive；2) 写同目录唯一 tmp（mode 0o600）；3) rename 到最终路径；
   *   4) 任一步失败 catch 时 rm tmp force 后原样抛出。
   */
  async writeTask(record: TaskRecord): Promise<void> {
    assertSafeTaskId(record.taskId);
    const dir = this.tasksDir();
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${record.taskId}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
      await rename(tmp, this.taskPath(record.taskId));
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * 一次性快照：单次 readdir 列出 tasks/*.json 后逐文件读取；
   * 非 .json（含 tmp 残留）过滤，畸形文件跳过不抛；按 taskId 字典序返回（确定性）。
   * owner 过滤（PRD §13.3 单写者）：owner 缺省/null = 全量（farm_status/GC）；
   * owner 为字符串 = 只返回该 owner 记录。
   */
  async scanTasks(owner?: string | null): Promise<TaskRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.tasksDir());
    } catch {
      return []; // tasks 目录不存在 → 空快照
    }
    names.sort();
    const records: TaskRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const taskId = name.slice(0, -".json".length);
      if (taskId === "") continue; // ".json" 文件本身：taskId 为空，按畸形跳过不抛
      const record = await this.readTask(taskId);
      if (record === null) continue;
      if (owner !== undefined && owner !== null && record.owner !== owner) continue;
      records.push(record);
    }
    return records;
  }

  /**
   * 消费 status/<taskId>.done 与 .aborted 信号文件（consumeSignal 动作，03-queue 调用）：
   * rm 前复查——不信任 tick 快照，即时重读后仅删此刻仍存在的文件，窄化
   * 「快照判定无信号 → 删除」间的竞态窗口；缺文件/目录不存在不抛。
   * 坏 JSON 的 done 文件同样删除（畸形信号不残留）。
   * 可选 beforeMs：仅删 mtime < beforeMs 的文件（= 本 attempt startedAt 之前的
   * 陈旧信号）；deadline 消费时 wrapper 恰写入的新 done（mtime ≥ beforeMs）
   * 予以保留，交给下一 tick 的 timeout×paneDone 迟到修正边——不丢真完成信号。
   * beforeMs 缺省 → 旧行为（存在即删，兼容 startedAt=0 的存量记录）。
   */
  async removeStatusSignal(taskId: string, opts?: { beforeMs?: number }): Promise<void> {
    assertSafeTaskId(taskId);
    const cutoff = typeof opts?.beforeMs === "number" && Number.isFinite(opts.beforeMs) ? opts.beforeMs : null;
    const donePath = join(this.statusDir(), `${taskId}.done`);
    const abortedPath = join(this.statusDir(), `${taskId}.aborted`);
    try {
      if (cutoff !== null) {
        const doneStat = await stat(donePath);
        if (doneStat.mtimeMs >= cutoff) throw new Error("fresh"); // 新信号保留
      } else {
        await readFile(donePath, "utf8"); // rm 前复查：文件尚在才删
      }
      await rm(donePath, { force: true });
    } catch {
      // 无 done 文件 / 新信号 → 跳过
    }
    try {
      if (cutoff !== null) {
        const abortedStat = await stat(abortedPath);
        if (abortedStat.mtimeMs >= cutoff) throw new Error("fresh"); // 新信号保留
      } else {
        await readFile(abortedPath, "utf8"); // rm 前复查
      }
      await rm(abortedPath, { force: true });
    } catch {
      // 无 aborted 文件 / 新信号 → 跳过
    }
  }

  /**
   * 读 status/<taskId>.done / .aborted：
   *   - .done 为 JSON {exitCode, sessionDir}（合法才认）→ {kind:"done", ...}；
   *   - .aborted 为标记文件，存在即 {kind:"aborted"}（内容不限）；
   *   - 两者俱在 → done 胜（pane 完成信号优先）；
   *   - 缺文件 / 畸形（坏 JSON、缺字段、目录等）→ 视为无该信号，不抛未预期异常；
   *   - 全无 → null。
   * opts.since 陈旧信号过滤（跨 attempt 竞态修复）：信号文件 mtime < since →
   * 陈旧（旧 attempt 残留）→ 按无信号处理；since 缺省/0/非有限数不过滤（兼容）。
   * 同 attempt 的迟到 done（mtime > startedAt）不受影响，照常生效。
   */
  async readStatusSignal(
    taskId: string,
    opts?: ReadStatusSignalOptions,
  ): Promise<StatusSignal | null> {
    assertSafeTaskId(taskId);
    const since = opts?.since;
    const cutoff = typeof since === "number" && Number.isFinite(since) && since > 0 ? since : 0;
    const donePath = join(this.statusDir(), `${taskId}.done`);
    const abortedPath = join(this.statusDir(), `${taskId}.aborted`);
    try {
      const doneStat = await stat(donePath);
      if (cutoff === 0 || doneStat.mtimeMs >= cutoff) {
        const done = parseDoneFile(await readFile(donePath, "utf8"));
        if (done !== null) return { kind: "done", ...done };
      }
      // 陈旧 done 或坏 JSON → 落入 aborted 检查
    } catch {
      // 缺文件 / 不可读 → 落入 aborted 检查
    }
    try {
      const abortedStat = await stat(abortedPath);
      if (cutoff > 0 && abortedStat.mtimeMs < cutoff) return null; // 陈旧 aborted → 无信号
      await readFile(abortedPath, "utf8"); // 标记文件：存在且可读即 aborted
      return { kind: "aborted" };
    } catch {
      return null;
    }
  }

  /**
   * 复查式删除（票 01）：readTask 现读 → 重验谓词 → rm force 幂等。
   *   ① assertSafeTaskId 先于一切 I/O（与 readTask/writeTask 同门抛 TypeError）；
   *   ② now / replayWindowMs 取 opts 或缺省（Date.now() / REPLAY_WINDOW_MS，constants.ts 单源）；
   *   ③ readTask 现读：缺文件 / 坏 JSON / 根非对象 → null → {deleted:false,reason:"missing"}
   *     不抛（坏文件「无法验谓词即不删」取安全方向，坏文件清理归 03 sweep 侧）；
   *   ④ !isTrulyTerminal → {deleted:false,reason:"not-terminal"}（复查时已复活/活跃/可复活）；
   *   ⑤ !isCleanableTerminal(record, now, replayWindowMs) → {deleted:false,reason:"unnotified"}
   *     （真终态但守卫不过：notifiedAt=0 且 updatedAt 仍在补发窗内——先删会丢通知，违 PRD §4.9）；
   *   ⑥ rm force 幂等（删链接本身、不跟随目标）；失败原样抛出（调用方记 failed 计数）。
   * ④⑤ 双层调用换取 reason 二分（可复活 vs 未通知）；isCleanableTerminal 内重复判
   * 真终态为无害纯函数调用。
   */
  async deleteTask(taskId: string, opts?: DeleteTaskOptions): Promise<DeleteTaskResult> {
    assertSafeTaskId(taskId);
    const now = opts?.now ?? Date.now();
    const replayWindowMs = opts?.replayWindowMs ?? REPLAY_WINDOW_MS;
    const record = await this.readTask(taskId);
    if (record === null) return { deleted: false, reason: "missing" };
    if (!isTrulyTerminal(record)) return { deleted: false, reason: "not-terminal" };
    if (!isCleanableTerminal(record, now, replayWindowMs)) {
      return { deleted: false, reason: "unnotified" };
    }
    await rm(this.taskPath(taskId), { force: true });
    return { deleted: true };
  }
}
