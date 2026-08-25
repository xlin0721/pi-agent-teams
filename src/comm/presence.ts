// src/comm/presence.ts
// comm 心跳注册表（票 01）：写 own presence + 读 role→paneId 映射 + 纯选择器。
//
// 写：每 pane 侧进程每 3s（PRESENCE_HEARTBEAT_MS 常量，循环归调用方）原子写
//   <root>/presence/<taskId>.json = {taskId,paneId,role,depth,pid,heartbeatAt}（tmp+mv，0600，写者=自身）。
// 读：readPresences 全量 + isAlive/listAlive/resolveRole 纯选择器（nowMs 纯参注入）。
// 零依赖：仅 node: 内置模块。role 缺失回退（scanTasks(null)）归调用方（msg 工具）。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** alive 窗口（heartbeatAt 距今 ≤ 10s） */
export const PRESENCE_ALIVE_MS = 10_000;
/** 写周期常量（3s；循环归调用方，见票 01 plan §5） */
export const PRESENCE_HEARTBEAT_MS = 3_000;

export interface Presence {
  taskId: string;
  paneId: string;
  role: string;
  depth: number;
  pid: number;
  heartbeatAt: number; // epoch ms
}

export interface WritePresenceInput {
  taskId: string;
  paneId: string;
  role: string;
  depth: number;
  pid: number;
}

/** 纯判定：alive = heartbeatAt 距今 ≤ 10s（nowMs 注入，epoch ms）。非有限 number → dead。 */
export function isAlive(p: Presence, nowMs: number): boolean {
  return (
    typeof p.heartbeatAt === "number" &&
    Number.isFinite(p.heartbeatAt) &&
    nowMs - p.heartbeatAt <= PRESENCE_ALIVE_MS
  );
}

function byTaskId(a: Presence, b: Presence): number {
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/** 纯选择器：存活实例，taskId 升序（确定性）。返回全新数组，不改输入。 */
export function listAlive(presences: readonly Presence[], nowMs: number): Presence[] {
  return presences.filter((p) => isAlive(p, nowMs)).sort(byTaskId);
}

/** 纯解析：role → 存活匹配实例的 paneId[]（同名并发多实例全取，taskId 升序，
 *  去重保序）。0 命中 → []（调用方 msg 工具以 scanTasks(null) 兜底）。 */
export function resolveRole(
  presences: readonly Presence[],
  role: string,
  nowMs: number,
): string[] {
  const matches = presences
    .filter((p) => isAlive(p, nowMs) && p.role === role)
    .sort(byTaskId);
  const paneIds: string[] = [];
  for (const m of matches) {
    if (!paneIds.includes(m.paneId)) paneIds.push(m.paneId);
  }
  return paneIds;
}

/** 解析 + 校验 presence 6 字段：taskId/paneId 非空 string、role string、
 *  depth/pid/heartbeatAt 有限 number。任一不符 → null（坏文件跳过，不抛）。 */
function validatePresence(parsed: unknown): Presence | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.taskId !== "string" || p.taskId === "") return null;
  if (typeof p.paneId !== "string" || p.paneId === "") return null;
  if (typeof p.role !== "string") return null;
  if (typeof p.depth !== "number" || !Number.isFinite(p.depth)) return null;
  if (typeof p.pid !== "number" || !Number.isFinite(p.pid)) return null;
  if (typeof p.heartbeatAt !== "number" || !Number.isFinite(p.heartbeatAt)) return null;
  return p as unknown as Presence;
}

async function readPresenceFile(file: string): Promise<Presence | null> {
  try {
    const raw: string = await readFile(file, "utf8");
    return validatePresence(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** I/O：读 <root>/presence/*.json → Presence[]（坏文件跳过；非 .json/tmp 过滤；taskId 升序）。
 *  presence 目录不存在 → []。 */
export async function readPresences(root: string): Promise<Presence[]> {
  const dir = join(root, "presence");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Presence[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const taskId = name.slice(0, -".json".length);
    const p = await readPresenceFile(join(dir, name));
    if (p !== null && p.taskId === taskId) out.push(p);
  }
  out.sort(byTaskId);
  return out;
}

/** taskId 安全段校验（写入口）：防路径逃逸。 */
function assertSafeTaskId(taskId: string): void {
  if (
    typeof taskId !== "string" ||
    taskId === "" ||
    taskId === "." ||
    taskId === ".." ||
    taskId.includes("/") ||
    taskId.includes("\\") ||
    taskId.includes("\0")
  ) {
    throw new TypeError(`invalid taskId: ${JSON.stringify(taskId)}`);
  }
}

/**
 * I/O：原子写 own presence → <root>/presence/<taskId>.json（tmp+mv，0600，写者=自身）。
 *  heartbeatAt 缺省 = Date.now()。返回落盘完整 Presence。
 *  原子写同 Inbox.#atomicWrite：同目录 per-writer 唯一 tmp → writeFile(0o600) → rename；
 *  失败 rm tmp 后原样抛出。
 */
export async function writePresence(
  root: string,
  input: WritePresenceInput,
  heartbeatAt?: number,
): Promise<Presence> {
  assertSafeTaskId(input.taskId);
  const presence: Presence = {
    taskId: input.taskId,
    paneId: input.paneId,
    role: input.role,
    depth: input.depth,
    pid: input.pid,
    heartbeatAt: heartbeatAt ?? Date.now(),
  };
  const dir = join(root, "presence");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${input.taskId}.json`);
  const tmp = join(dir, `.${input.taskId}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(presence), { mode: 0o600 });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return presence;
}
