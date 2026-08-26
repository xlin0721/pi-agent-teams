// src/comm/inbox.ts
// comm 文件通道读侧轮询器（票 01）：pollInbox 单次轮询 + readInboxSnapshot 只读快照。
//
// 写侧复用 task-core/steer.ts 的 Inbox（deliver/advance/pickLatest，零 diff）；
// 本模块只做「列目录 → 解析校验 → 新鲜度 watermark → latest-wins/全量分派 →
// 三态 advance」。零依赖：仅 node: 内置 + 相对 .ts import。
//
// 关键决策（.scratch/m3-command/plans/01-plan.md 已批准）：
//   - watermark 从磁盘现成数据读（本目录 delivered/read 消息最大 ts），零新状态文件；
//   - 首读无 watermark 时用 mtime ≤ freshMs(60s) 兜底防陈旧文件；
//   - supersede = 两次 advance（pending→delivered→read），严格复用 Inbox.advance；
//   - at-most-once：advance 到 delivered 在 sink 之前、read 在 sink 成功之后；
//     sink 抛错 → 停留 delivered 不重投（崩溃间隙由 24h GC 兜底）；
//   - 时钟注入（now）+ sink 回调（(msg) => void | Promise<void>），400ms 循环归调用方。

import { Inbox, pickLatest, type InboxMessage } from "../task-core/steer.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** sink 契约：投递回调。TUI=index.ts 传 pi.sendMessage 闭包；B=render-mini.ts 传渲染行/stdin rpc 闭包。
 *  pollInbox 保证：按序交一次、不因 sink 抛错崩循环；msg.type/msg.delivery 由 sink 自行映射。 */
export type PollSink = (msg: InboxMessage) => void | Promise<void>;

export interface PollInboxOptions {
  /** 时钟注入（测试）；缺省 Date.now */
  now?: () => number;
  /** 首读无 watermark 时的 mtime 兜底窗口（ms）；缺省 60_000 */
  freshMs?: number;
  /** 收信 pane 自身 depth（C9 读侧兜底）：ownDepth ≥ msg.depthCap 的消息跳过不投递 */
  ownDepth?: number;
}

export interface PollResult {
  /** 本轮成功送达并 advance 到 read 的消息（status="read"；投递序：steer 先、msg 按 ts 升序） */
  delivered: InboxMessage[];
  /** latest-wins supersede 记 read 的旧 pending steer 数 */
  superseded: number;
  /** 跳过条数（坏 JSON / 路径逃逸 / 畸形 msgId / watermark 拒 replay / mtime 陈旧） */
  skipped: number;
  /** sink 抛错的消息数（停留 delivered，本轮不重投，见 at-most-once） */
  sinkFailed: number;
}

/** 路径段防逃逸：非空字符串，且不含目录成分（/、\、NUL、"."、".."）。
 *  与 Inbox.#assertSafeSegment 同款规则（私有本地实现，不 import 私有成员）。 */
function isSafeSegment(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }
  return true;
}

/** 解析 + 校验一条消息：msgId 须 === 文件名派生 msgId、to 须 === 目录 paneId（身份字段
 *  范式，同 msgId===文件名 / presence taskId===文件名）、枚举合法、ts 有限、from 非空。
 *  任一不符 → null（坏 JSON / 畸形 / 路径逃逸防御，不抛）。 */
function validateMessage(parsed: unknown, msgId: string, paneId: string): InboxMessage | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.msgId !== "string" || m.msgId !== msgId) return null;
  if (m.type !== "steer" && m.type !== "msg") return null;
  if (m.delivery !== "notice" && m.delivery !== "directive") return null;
  if (m.status !== "pending" && m.status !== "delivered" && m.status !== "read") return null;
  if (typeof m.ts !== "number" || !Number.isFinite(m.ts)) return null;
  if (typeof m.from !== "string" || m.from.length === 0) return null;
  if (m.to !== paneId) return null;
  if (typeof m.content !== "string") return null;
  // C9 depthCap 可选字段：存在则必须为有限数（缺省 undefined 兼容存量消息）
  if (
    m.depthCap !== undefined &&
    (typeof m.depthCap !== "number" || !Number.isFinite(m.depthCap))
  ) {
    return null;
  }
  return m as unknown as InboxMessage;
}

/** 读单文件 → 合法消息 | null（读失败 / 坏 JSON / 校验失败一律 null，不抛）。 */
async function readMessageFile(
  file: string,
  msgId: string,
  paneId: string,
): Promise<InboxMessage | null> {
  try {
    const raw: string = await readFile(file, "utf8");
    return validateMessage(JSON.parse(raw) as unknown, msgId, paneId);
  } catch {
    return null;
  }
}

/** 投递候选（pending 消息 + 其文件 mtime，供首读 60s 兜底）。 */
interface Candidate {
  msg: InboxMessage;
  mtimeMs: number;
}

/**
 * 单次轮询 inbox/<paneId>/：
 *   1. paneId 路径守卫；2. 列目录；3. 逐文件解析 + 校验 + stat mtime；
 *   4. 新鲜度 gate（watermark 单次快照 / 首读 mtime 60s 兜底）；
 *   5. steer latest-wins（其余 supersede）、msg 全量 ts 升序；
 *   6. 逐条 deliverOne（advance delivered → sink → advance read；sink 抛错不崩）。
 */
export async function pollInbox(
  inboxRoot: string,
  paneId: string,
  sink: PollSink,
  opts: PollInboxOptions = {},
): Promise<PollResult> {
  const result: PollResult = { delivered: [], superseded: 0, skipped: 0, sinkFailed: 0 };
  if (!isSafeSegment(paneId)) return result;

  const dir = join(inboxRoot, "inbox", paneId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return result; // inbox 目录尚不存在 → 空结果
  }

  const candidates: Candidate[] = [];
  let watermark: number | null = null;

  for (const entry of names) {
    if (!entry.endsWith(".json")) continue; // 非 .json / .tmp 忽略，不计数
    const msgId = entry.slice(0, -".json".length);
    if (!isSafeSegment(msgId)) {
      result.skipped++;
      continue;
    }
    const file = join(dir, entry);
    const msg = await readMessageFile(file, msgId, paneId);
    if (msg === null) {
      result.skipped++;
      continue;
    }
    let mtimeMs: number;
    try {
      const s = await stat(file);
      mtimeMs = s.mtimeMs;
    } catch {
      result.skipped++;
      continue;
    }
    if (msg.status === "pending") {
      candidates.push({ msg, mtimeMs });
    } else if (watermark === null || msg.ts > watermark) {
      watermark = msg.ts;
    }
  }

  const nowFn = opts.now ?? Date.now;
  const freshMs = opts.freshMs ?? 60_000;
  const now = nowFn();

  // 新鲜度 gate（watermark 本轮单次快照；首读走 mtime 60s 兜底）
  const accepted: InboxMessage[] = [];
  for (const c of candidates) {
    if (watermark !== null) {
      if (c.msg.ts <= watermark) {
        result.skipped++; // replay 拒：保持 pending，由 24h GC 回收
        continue;
      }
    } else if (now - c.mtimeMs > freshMs) {
      result.skipped++; // 陈旧文件兜底
      continue;
    }
    accepted.push(c.msg);
  }

  const inbox = new Inbox(inboxRoot);
  // C9 读侧兜底：ownDepth ≥ depthCap 的消息由收信 pane 直接消费（两次 advance 记 read，
  // supersede 同款），不投递 sink、计 skipped——防投递侧漏过滤时 depth-2 仍被劫持。
  const depthGateSkip = async (msg: InboxMessage): Promise<void> => {
    try {
      await inbox.advance(msg.msgId, paneId, "delivered");
      await inbox.advance(msg.msgId, paneId, "read");
    } catch {
      // 竞态（文件并发删除/推进）忽略：不投递决策不变
      return;
    }
    result.skipped++;
  };
  const steers: InboxMessage[] = [];
  const msgs: InboxMessage[] = [];
  for (const m of accepted) {
    if (typeof opts.ownDepth === "number" && typeof m.depthCap === "number" && opts.ownDepth >= m.depthCap) {
      await depthGateSkip(m);
      continue;
    }
    if (m.type === "steer") steers.push(m);
    else msgs.push(m);
  }

  // steer 先（directive 优先级）：latest-wins，其余旧 pending steer 记 read（supersede）
  if (steers.length > 0) {
    const latest = pickLatest(steers);
    if (latest !== null) {
      for (const s of steers) {
        if (s.msgId === latest.msgId) continue;
        await supersedeOne(inbox, paneId, s, result);
      }
      await deliverOne(inbox, paneId, latest, sink, result);
    }
  }

  // msg 全量按 ts 升序（平手 msgId 升序）逐条投递
  msgs.sort((a, b) =>
    a.ts !== b.ts ? a.ts - b.ts : a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0,
  );
  for (const m of msgs) {
    await deliverOne(inbox, paneId, m, sink, result);
  }

  return result;
}

/** supersede：两次 advance（pending→delivered→read）。竞态（文件被并发删除/推进）忽略，
 *  supersede 决策不变、at-most-once 不受影响。 */
async function supersedeOne(
  inbox: Inbox,
  paneId: string,
  msg: InboxMessage,
  result: PollResult,
): Promise<void> {
  try {
    await inbox.advance(msg.msgId, paneId, "delivered");
    await inbox.advance(msg.msgId, paneId, "read");
  } catch {
    return; // 竞态忽略
  }
  result.superseded++;
}

/** 逐条投递：advance delivered → await sink → 成功 advance read；
 *  sink 抛错 → sinkFailed++、停留 delivered、继续下一条（不崩循环）。 */
async function deliverOne(
  inbox: Inbox,
  paneId: string,
  msg: InboxMessage,
  sink: PollSink,
  result: PollResult,
): Promise<void> {
  try {
    await inbox.advance(msg.msgId, paneId, "delivered");
  } catch {
    result.skipped++;
    return;
  }
  try {
    await sink(msg);
  } catch {
    result.sinkFailed++;
    return; // 停留 delivered（已交 sink 一次，at-most-once 不重投）
  }
  try {
    await inbox.advance(msg.msgId, paneId, "read");
  } catch {
    // read 推进竞态失败：sink 已成功、at-most-once 已保证，忽略
  }
  result.delivered.push({ ...msg, status: "read" });
}

/**
 * 只读快照（零副作用，不 advance 不调 sink）：inbox/<paneId>/ 全部合法消息
 * （含 pending/delivered/read），按 ts 升序 + msgId 破序（确定性）。
 * 供 feed 投递态列 / 票 07 面板做数据源。
 */
export async function readInboxSnapshot(root: string, paneId: string): Promise<InboxMessage[]> {
  if (!isSafeSegment(paneId)) return [];
  const dir = join(root, "inbox", paneId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: InboxMessage[] = [];
  for (const entry of names) {
    if (!entry.endsWith(".json")) continue;
    const msgId = entry.slice(0, -".json".length);
    if (!isSafeSegment(msgId)) continue;
    const msg = await readMessageFile(join(dir, entry), msgId, paneId);
    if (msg !== null) out.push(msg);
  }
  out.sort((a, b) =>
    a.ts !== b.ts ? a.ts - b.ts : a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0,
  );
  return out;
}
