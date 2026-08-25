// src/display/split.ts
// wezterm cli 封装纯原语（display 层）：spawn / listPanes / kill / killSync + runner 注入。
// killSync（06 装配票补齐，T5 声明的 DisplayClient.killSync 接口实现）：spawnSync
// 同步 kill，session_shutdown 全 kill 用（防异步 fire-and-forget 进程退出前未完成）。
//
// 权威事实来源：.scratch/m2-background-mode/spike-facts.md（票 02 实机验证）。
//   - spawn 成功时 stdout 直接打印新 pane-id（spike §10），无需 list 回查；
//   - spawn 默认 cwd = $HOME（spike §10），必须显式 --cwd；macOS 下 /tmp 会被
//     解析为 /private/tmp（spike §1），传入前转换 toCliCwd；
//   - 一切 cli 调用带 --no-auto-start（spike §2 起全部实测命令一致）；
//   - 禁用 --prefer-mux：无 mux server 时硬失败、即使 GUI socket 活着也不回退
//     （spike §4），默认连接（env 变量 > default 域 symlink）即最优；
//   - kill 不存在 pane → exit 1、stderr 含 `no such pane`（spike §6），幂等 kill
//     容忍此 stderr（重试 kill 旧 paneId 时 pane 可能已被 watchdog 收走）。
// 本模块零 task-core/store import（display 不感知农场）；探测循环/降级决策归 05 farm。
// docs-internal/PRD-v3.md §13.2：display 层为纯原语；spawn(task) 装配与 {paneId, sessionDir}
// 落盘在 farm/Executor（06 装配点）。

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { parseList } from "./protocol.ts";
import type { PaneInfo } from "./protocol.ts";
import { placementToArgs } from "./grid.ts";
import type { GridPlacement } from "./grid.ts";

export interface CliOutput {
  stdout: string;
  stderr: string;
}

/** cli runner 注入接缝：默认真 execFile("wezterm")，测试注入 fake。 */
export type CliRunner = (args: string[]) => Promise<CliOutput>;

/** 同步 cli 调用输出（killSync 用）。 */
export interface SyncCliOutput {
  /** 退出码；null = 无法启动 wezterm（spawnSync 抛 ENOENT 等） */
  status: number | null;
  stderr: string;
}

/** 同步 cli runner 注入接缝：默认 spawnSync("wezterm")，测试注入 fake。 */
export type SyncCliRunner = (args: string[]) => SyncCliOutput;

/** cli 调用失败（非零 exit 或输出不合预期），携带 stderr 供 classifyCliFailure 判定。 */
export class CliError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "CliError";
    this.stderr = stderr;
  }
}

const execFileAsync = promisify(execFile);

/** 默认同步 runner：spawnSync("wezterm")；二进制不可用（抛 ENOENT）→ status null。 */
export function weztermSyncCliRunner(): SyncCliRunner {
  return (args: string[]): SyncCliOutput => {
    try {
      const out = spawnSync("wezterm", args, { encoding: "utf8" });
      return {
        status: typeof out.status === "number" ? out.status : null,
        stderr: typeof out.stderr === "string" ? out.stderr : "",
      };
    } catch {
      return { status: null, stderr: "" };
    }
  };
}

/** 默认 runner：真 execFile("wezterm")；非零 exit → 抛 CliError（stderr 原文透传）。 */
export function weztermCliRunner(): CliRunner {
  return async (args: string[]): Promise<CliOutput> => {
    try {
      const out = (await execFileAsync("wezterm", args, { encoding: "utf8" })) as CliOutput;
      return { stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
    } catch (err) {
      const e = err as { stderr?: unknown; message?: unknown };
      const stderr = typeof e.stderr === "string" ? e.stderr : "";
      throw new CliError(`wezterm ${args.join(" ")} 失败: ${String(e.message ?? err)}`, stderr);
    }
  };
}

/**
 * --cwd 参数转换（spike §1）：macOS 下 /tmp 是 /private/tmp 的符号链接，wezterm
 * 落盘 cwd 为 file:///private/tmp/ 形态。传入 /tmp 前缀的路径时提前转为
 * /private/tmp 形态，保证 list 回读的 cwd 与 task record 落盘值可比。
 */
export function toCliCwd(cwd: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "darwin") return cwd;
  if (cwd === "/tmp") return "/private/tmp";
  if (cwd.startsWith("/tmp/")) return "/private" + cwd;
  return cwd;
}

const PANE_ID_RE = /^[0-9]+$/;

/** display 层纯原语（PRD §13.2）：spawn / listPanes / kill，无探测循环、无降级决策。 */
export class DisplayClient {
  private readonly run: CliRunner;
  private readonly runSync: SyncCliRunner;
  constructor(runner?: CliRunner, syncRunner?: SyncCliRunner) {
    this.run = runner ?? weztermCliRunner();
    this.runSync = syncRunner ?? weztermSyncCliRunner();
  }

  /**
   * `wezterm cli --no-auto-start split-pane [<placement>|--right] [--cwd <dir>] -- <cmd...>`
   * → stdout 即新 pane-id（spike §10）。opts.placement 有值 → placementToArgs 替换默认
   * --right（插入 --cwd 之后、-- 之前，非 push，避免双 --right）；无 → 保持 --right
   * （向后兼容，现有调用零改动）。stdout 非纯数字 → 抛 CliError（spawn 失败信号，重试
   * 决策归 farm）。
   */
  async spawn(cmd: string[], opts: { cwd?: string; placement?: GridPlacement } = {}): Promise<string> {
    const args = ["cli", "--no-auto-start", "split-pane"];
    if (opts.placement === undefined) args.push("--right"); // 默认 --right（向后兼容，字节不变）
    if (opts.cwd !== undefined) args.push("--cwd", toCliCwd(opts.cwd));
    if (opts.placement !== undefined) args.push(...placementToArgs(opts.placement)); // 替换默认 --right，--cwd 之后、-- 之前
    args.push("--", ...cmd);
    const { stdout } = await this.run(args);
    const paneId = stdout.trim();
    if (!PANE_ID_RE.test(paneId)) {
      throw new CliError(`split-pane 未返回 pane-id，stdout: ${JSON.stringify(stdout)}`, "");
    }
    return paneId;
  }

  /** `wezterm cli --no-auto-start list --format json` → parseList 纯解析（字段缺失容错）。 */
  async listPanes(): Promise<PaneInfo[]> {
    const { stdout } = await this.run(["cli", "--no-auto-start", "list", "--format", "json"]);
    return parseList(stdout);
  }

  /**
   * `wezterm cli --no-auto-start kill-pane --pane-id <id>`。
   * 幂等：pane 已不存在（stderr 含 `no such pane`，spike §6）视为成功；
   * 其余失败（含 L1）原样抛出。
   */
  async kill(paneId: number | string): Promise<void> {
    try {
      await this.run(["cli", "--no-auto-start", "kill-pane", "--pane-id", String(paneId)]);
    } catch (err) {
      if (err instanceof CliError && /no such pane/.test(err.stderr)) return;
      throw err;
    }
  }

  /**
   * 同步 kill（session_shutdown 全 kill 用，T5 声明接口）：spawnSync
   * `wezterm cli --no-auto-start kill-pane --pane-id <id>`，防进程退出前
   * 异步 fire-and-forget 未完成。幂等：stderr 含 `no such pane`（spike §6）
   * 视为成功；其余失败（含 L1、二进制缺失）抛 CliError。
   */
  killSync(paneId: number | string): void {
    const out = this.runSync(["cli", "--no-auto-start", "kill-pane", "--pane-id", String(paneId)]);
    if (out.status === 0) return;
    if (/no such pane/.test(out.stderr)) return;
    const reason = out.status === null ? "无法启动 wezterm" : `exit ${out.status}`;
    throw new CliError(
      `wezterm cli --no-auto-start kill-pane --pane-id ${paneId} 失败（${reason}）`,
      out.stderr,
    );
  }
}
