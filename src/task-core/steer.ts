// src/task-core/steer.ts
// steer/消息投递核心（docs-internal/PRD-v3.md §13.3 inbox schema）。
//
// 职责：向注入的根目录原子写 inbox 消息（<root>/inbox/<to>/<msgId>.json）；
// latest-wins = 写侧戳 nonce（ts 字段兼任，同进程单调）+ 读侧 pickLatest() 纯助手；
// 投递态 status 只允许 pending→delivered→read 单向推进（pane 侧单写者）。
//
// 范围 pin（票 04 已批准方案）：
// - nonce = ts 字段兼任，不扩 schema；main 单写者同进程单调；
// - to="all" 的 fan-out 与 status 语义留 M2，本模块只按普通段目录写文件；
// - advance(msgId, to, next) 三参形态；
// - 零依赖：仅 node: 前缀内置模块。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type MessageType = "steer" | "msg";
export type Delivery = "notice" | "directive";
export type DeliveryStatus = "pending" | "delivered" | "read";

/** inbox 消息 record（严格 §13.3 schema；C9 起含可选 depthCap，缺省 undefined 兼容存量）。 */
export interface InboxMessage {
  msgId: string;
  type: MessageType;
  from: string;
  to: string;
  delivery: Delivery;
  content: string;
  status: DeliveryStatus;
  ts: number;
  /** 读侧兜底门（C9）：ownDepth ≥ depthCap 的收信 pane 跳过（会议广播传 2）；缺省不写 */
  depthCap?: number;
}

/** deliver 入参：msgId/status/ts 由写侧生成，调用方只给这五字段（depthCap 可选）。 */
export interface DeliverInput {
  type: MessageType;
  from: string;
  to: string;
  delivery: Delivery;
  content: string;
  depthCap?: number;
}

const MESSAGE_TYPES: readonly string[] = ["steer", "msg"];
const DELIVERIES: readonly string[] = ["notice", "directive"];
const ADVANCE_TARGETS: readonly string[] = ["delivered", "read"];

function assertEnum(
  value: unknown,
  allowed: readonly string[],
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join("|")}`);
  }
}

/** 路径段防逃逸：非空字符串，且不含目录成分（/、\、NUL、"."、".."）。 */
function assertSafeSegment(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError(`${field} must not contain path separators or ".."`);
  }
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

export class Inbox {
  #root: string;
  #lastTs = 0;

  constructor(inboxRoot: string) {
    if (typeof inboxRoot !== "string" || inboxRoot.length === 0) {
      throw new TypeError("inboxRoot must be a non-empty string");
    }
    this.#root = inboxRoot;
  }

  /**
   * 投递一条消息：生成 msgId（randomUUID）、ts（单调 nonce）、status="pending"，
   * 原子写 <root>/inbox/<to>/<msgId>.json，返回完整落盘消息。
   */
  async deliver(input: DeliverInput): Promise<InboxMessage> {
    assertEnum(input.type, MESSAGE_TYPES, "type");
    assertEnum(input.delivery, DELIVERIES, "delivery");
    assertSafeSegment(input.to, "to");
    if (typeof input.from !== "string" || input.from.length === 0) {
      throw new TypeError("from must be a non-empty string");
    }
    if (typeof input.content !== "string") {
      throw new TypeError("content must be a string");
    }
    const msg: InboxMessage = {
      msgId: randomUUID(),
      type: input.type,
      from: input.from,
      to: input.to,
      delivery: input.delivery,
      content: input.content,
      status: "pending",
      ts: this.#nextTs(),
      ...(typeof input.depthCap === "number" ? { depthCap: input.depthCap } : {}),
    };
    await this.#atomicWrite(this.#msgPath(msg.to, msg.msgId), JSON.stringify(msg));
    return msg;
  }

  /**
   * 投递态严格单步推进（pane 侧唯一写 status）：
   * pending→delivered、delivered→read；其余一律抛错——
   * 跳级（pending→read）、回退（read→delivered）、重复推进、消息不存在、路径逃逸。
   * 返回更新后的完整消息，其余字段原样保留。
   */
  async advance(
    msgId: string,
    to: string,
    next: Exclude<DeliveryStatus, "pending">,
  ): Promise<InboxMessage> {
    assertSafeSegment(msgId, "msgId");
    assertSafeSegment(to, "to");
    assertEnum(next, ADVANCE_TARGETS, "next");
    const file = this.#msgPath(to, msgId);
    let current: InboxMessage;
    try {
      current = JSON.parse(await readFile(file, "utf8")) as InboxMessage;
    } catch (err) {
      if (isErrno(err, "ENOENT")) {
        throw new Error(`message not found: ${msgId}`);
      }
      if (err instanceof SyntaxError) {
        throw new Error(`invalid message JSON for ${msgId}: ${err.message}`);
      }
      throw err;
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      const got = current === null ? "null" : Array.isArray(current) ? "array" : typeof current;
      throw new Error(`invalid message JSON for ${msgId}: root must be an object, got ${got}`);
    }
    const expected: DeliveryStatus = next === "delivered" ? "pending" : "delivered";
    if (current.status !== expected) {
      throw new Error(
        `illegal status advance: ${current.status} -> ${next} (expected ${expected} -> ${next})`,
      );
    }
    const updated: InboxMessage = { ...current, status: next };
    await this.#atomicWrite(file, JSON.stringify(updated));
    return updated;
  }

  #msgPath(to: string, msgId: string): string {
    return join(this.#root, "inbox", to, `${msgId}.json`);
  }

  /** nonce = ts（schema 不扩字段）：同进程单写者内单调递增（Date.now() 平手时自增）。 */
  #nextTs(): number {
    const now = Date.now();
    this.#lastTs = now > this.#lastTs ? now : this.#lastTs + 1;
    return this.#lastTs;
  }

  /**
   * 原子写：同目录 per-writer 唯一 tmp（.<msgId>.json.<pid>.<uuid>.tmp）→ rename；
   * 失败时清理 tmp 后原样抛出。
   */
  async #atomicWrite(file: string, data: string): Promise<void> {
    const dir = dirname(file);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

/**
 * latest-wins 读侧纯助手：返回 ts 最大者；ts 平手取 msgId 字典序大者；
 * 空数组返回 null。纯函数：不修改输入。
 */
export function pickLatest(msgs: readonly InboxMessage[]): InboxMessage | null {
  if (msgs.length === 0) return null;
  let best = msgs[0];
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.ts > best.ts || (m.ts === best.ts && m.msgId > best.msgId)) {
      best = m;
    }
  }
  return best;
}
