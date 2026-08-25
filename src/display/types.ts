// src/display/types.ts
// 渲染器共享类型（票 04 R#7 拆分自 render-core.ts）。零依赖、零副作用。

// ── 类型 ──────────────────────────────────────────────────────────────────

export interface TermSize {
  rows: number;
  cols: number;
}

export type LineKind =
  | "system" // 系统/首屏（dim）
  | "phase" // 生命周期阶段标记（bold yellow）
  | "user" // user 消息回显（steer 送达，cyan）
  | "assistant" // assistant 文本（原色）
  | "thinking" // thinking 文本（dim）
  | "tool" // 工具起止摘要（cyan）
  | "tool-error"; // 工具错误（red + ✗ 失败文字标记）

export interface RenderLine {
  text: string;
  kind: LineKind;
}

/** 状态条数据模型（taskId8/角色/阶段/回合/token/耗时锚 startedAt/farm 标签/steer 排队态） */
export interface StatusModel {
  taskId: string;
  taskId8: string;
  role: string;
  phase: string;
  turn: number;
  totalTokens: number | null;
  /** 耗时锚：task record startedAt（启动时读一次，零写入）；0 → 渲染器启动时刻 */
  startedAt: number;
  /** farm 状态标签（B 形态恒「运行中」） */
  label: string;
  /** steer 排队条数（queue_update.steering.length，spike §Q 容错） */
  steerQueued: number;
  /** 乐观瞬态：提交 steer 后、queue_update 回来前为 true（显示「已发送」，票 06 追加） */
  steerSent: boolean;
  /** steer 通道关闭（EPIPE/ERR_STREAM_DESTROYED/ERR_STREAM_WRITE_AFTER_END 收敛，spike §E） */
  steerClosed: boolean;
  /** steer 被 pi 拒绝（response success:false，附原因或 null） */
  steerRejected: string | null;
  badLines: number;
  oversizeLines: number;
  /** session header cwd（version≠3 容忍） */
  cwd: string;
  elapsedMs: number;
}

// node 流/子进程最小结构面：node:* 通配声明为 any（node-modules.d.ts），本模块
// 以结构化类型定义边界（不引 @types/node）。真实 ChildProcess/Readable/Writable
// 结构兼容（stdio stdin=Writable、stdout=Readable、child.on/kill 齐备）；测试用
// 假实现同型注入。

export interface ChunkLike {
  toString(): string;
}

export interface ReadableLike {
  on(event: "data", listener: (chunk: ChunkLike) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
  resume?: () => unknown;
}

export interface WritableLike {
  write(chunk: string, callback?: (err?: unknown) => void): unknown;
  on?(event: "error", listener: (err: unknown) => void): unknown;
}

export interface PiChild {
  pid?: number;
  /** stdin = rpc 命令通道（prompt/steer 行协议）；stdout = 事件流 */
  stdin: WritableLike;
  stdout: ReadableLike;
  stderr?: ReadableLike;
  kill?(signal?: string): unknown;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
}

export type SpawnPi = () => PiChild;


export interface UsageInfo {
  input: number;
  output: number;
  totalTokens: number | null;
}

