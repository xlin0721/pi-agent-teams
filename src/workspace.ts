// src/workspace.ts
// 工作区隔离（C1）：FARM_ROOT 由 cwd 派生 per-workspace 目录；全局配置
// （pricing.json / config.json）留在 ~/.pi-agent-teams 全局根（GLOBAL_ROOT）。
//
// 解析优先级：
//   env PI_AGENT_TEAMS_ROOT（spawn 链显式传递，pane 与 main 强一致）> cwd 派生
//   （realpath 归一化 → sha256 取 12 hex workspaceId）
// 无 legacy 回退（存量历史数据留在旧根归档、不再读取——用户裁定 2026-08-26）。
//
// 纯函数（零 I/O，除 node:fs realpathSync 读侧归一化）；tsc strict 可测。

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/** spawn 链传递工作区根的 env 变量名（wrapperCommand 注入，pane 侧读之） */
export const WS_ENV = "PI_AGENT_TEAMS_ROOT";
/** workspaceId 长度（sha256 前 12 hex；碰撞面 ~2^48，够本机多项目区分） */
export const WS_ID_LEN = 12;

export interface WorkspaceRoot {
  /** 全局根：~/.pi-agent-teams（pricing.json/config.json 读写点，不随工作区分区） */
  globalRoot: string;
  /** 工作区根：~/.pi-agent-teams/<workspaceId>（tasks/status/presence/inbox/... 运行态目录） */
  farmRoot: string;
  /** 12 hex workspaceId（env 来源时为空串，fARM 根由 env 直接给定） */
  workspaceId: string;
  /** 来源：env（spawn 链显式传递）| derived（cwd 派生） */
  source: "env" | "derived";
}

/** realpath 归一化：符号链接/别名（macOS /tmp→/private/tmp）不裂区；失败回退原 cwd。 */
export function normalizeWorkspaceCwd(cwd: string): string {
  if (typeof cwd !== "string" || cwd === "") return cwd;
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** workspaceId：normalize 后 sha256 前 12 hex（确定性、无目录名碰撞、无路径逃逸面）。 */
export function workspaceIdOf(cwd: string): string {
  const norm = normalizeWorkspaceCwd(cwd);
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, WS_ID_LEN);
}

/** 解析工作区根：envRoot 显式（spawn 链传递）> cwd 派生；cwd 空/非法 → 回退 home 派生。 */
export function resolveWorkspaceRoot(opts: {
  cwd: string;
  home: string;
  envRoot?: string;
}): WorkspaceRoot {
  const globalRoot = join(opts.home, ".pi-agent-teams");
  const envRoot = typeof opts.envRoot === "string" ? opts.envRoot.trim() : "";
  if (envRoot !== "") {
    return { globalRoot, farmRoot: envRoot, workspaceId: "", source: "env" };
  }
  const cwd = typeof opts.cwd === "string" && opts.cwd !== "" ? opts.cwd : opts.home;
  const wsId = workspaceIdOf(cwd);
  return { globalRoot, farmRoot: join(globalRoot, wsId), workspaceId: wsId, source: "derived" };
}
