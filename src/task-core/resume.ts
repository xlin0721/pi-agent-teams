// src/task-core/resume.ts
// 恢复命令构建与 session id 解析（纯构建器，零依赖、仅 node: 内置 import）
//
// 依据：PRD-v3.md §4.4 FR4 — 恢复 = `pi -p --session-dir <dir> --session <id>`
//（必须带 --session）；session id 从会话 jsonl 文件名 `*_<uuid>.jsonl` 解析。
// 本模块只产参数数组（不含 "pi"），供 M2 以 spawn("pi", args) 直接使用。
// 输入约定：文件名入参为 basename（不含目录成分）。

import { readdir } from "node:fs/promises";

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * 组装 resume 命令参数（不含 "pi"）。
 * 形态：["-p", "--session-dir", <sessionDir>, "--session", <sessionId>]
 * 空串（或非字符串）入参抛 TypeError。
 */
export function buildResumeArgs(sessionDir: string, sessionId: string): string[] {
  if (typeof sessionDir !== "string" || sessionDir === "") {
    throw new TypeError("sessionDir must be a non-empty string");
  }
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new TypeError("sessionId must be a non-empty string");
  }
  return ["-p", "--session-dir", sessionDir, "--session", sessionId];
}

/**
 * 从会话 jsonl 文件名解析 session id。三步校验：
 *   1) 以 ".jsonl" 结尾；
 *   2) 含 uuid（8-4-4-4-12 十六进制）且唯一；
 *   3) 文件名以 `_<uuid>.jsonl` 结尾。
 * 畸形（无 uuid / 多 uuid / 非 jsonl / uuid 不在尾段）→ null。
 * 命中时返回原样（不 lowercase）。
 */
export function parseSessionId(filename: string): string | null {
  if (typeof filename !== "string") return null;
  if (!filename.endsWith(".jsonl")) return null;
  const matches = filename.match(UUID_PATTERN);
  if (matches === null || matches.length !== 1) return null; // 无 uuid 或多 uuid
  const uuid = matches[0];
  if (!filename.endsWith("_" + uuid + ".jsonl")) return null;
  return uuid;
}

/**
 * 从 sessionDir 找最新会话 jsonl 并解析 session id（farm.ts/index.ts 共用；
 * 原两份同款逻辑合并至本模块）。
 * 文件名排序倒序取第一个可解析 id（ts 前缀同格式下 = 最新落盘）；
 * 目录不存在/不可读/无合法 jsonl → null。
 */
export async function findSessionId(sessionDir: string): Promise<string | null> {
  if (typeof sessionDir !== "string" || sessionDir === "") return null;
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch {
    return null;
  }
  names.sort().reverse();
  for (const name of names) {
    const id = parseSessionId(name);
    if (id !== null) return id;
  }
  return null;
}
