// src/display/protocol.ts
// wezterm cli 纯原语（display 层）：list JSON 纯解析 + L1 降级判定纯函数。
//
// 权威事实来源：.scratch/m2-background-mode/spike-facts.md（票 02 实机验证）。
//   - 字段名以 spike §1 完整字段清单为准；全部 optional（版本漂移防御：字段缺失
//     或改型不抛错、宁缺毋错）；
//   - L1 判定 = stderr 匹配 `failed to connect to Socket(` 模式（spike §2/§9）：
//     exit code 不能区分 L1 与运行时错误（同为 exit 1），L1 下全部子命令统一失败、
//     stdout 空，故只能匹配 stderr 原文；
//   - 语义要点（spike §1/§5）：window_id/tab_id/pane_id 全局单调不复用，pane-id
//     可作跨调用稳定句柄；cwd 为 file:// URI；is_active 每 tab 各自一个；
//     cursor_* / left_col / top_row 每次调用都变（轮询勿依赖其稳定性）。
// 零 I/O、零依赖；display 层不 import task-core/store。

/** L1（GUI/mux 不可达）stderr 判别模式（spike §2 实测原文）。 */
export const L1_STDERR_PATTERN = /failed to connect to Socket\(/;

/** 降级判定结果："l1" = GUI/mux 不可达（spike §9：全农场降级）；"other" = 运行时/其他错误。 */
export type DegradeVerdict = "l1" | "other";

/** list --format json 单 pane 条目（spike §1 全字段清单）。 */
export interface PaneInfo {
  window_id?: number;
  tab_id?: number;
  pane_id?: number;
  workspace?: string;
  size?: PaneSize;
  title?: string;
  cwd?: string;
  cursor_x?: number;
  cursor_y?: number;
  cursor_shape?: string;
  cursor_visibility?: string;
  left_col?: number;
  top_row?: number;
  tab_title?: string;
  window_title?: string;
  is_active?: boolean;
  is_zoomed?: boolean;
  tty_name?: string;
}

export interface PaneSize {
  rows?: number;
  cols?: number;
  pixel_width?: number;
  pixel_height?: number;
  dpi?: number;
}

// 类型白名单：逐字段按期望类型拷贝；类型不符（未来版本改型）不拷贝，宁缺毋错。
const STRING_KEYS = [
  "workspace", "title", "cwd", "cursor_shape", "cursor_visibility",
  "tab_title", "window_title", "tty_name",
] as const;
const NUMBER_KEYS = [
  "window_id", "tab_id", "pane_id", "cursor_x", "cursor_y", "left_col", "top_row",
] as const;
const BOOLEAN_KEYS = ["is_active", "is_zoomed"] as const;
const SIZE_NUMBER_KEYS = ["rows", "cols", "pixel_width", "pixel_height", "dpi"] as const;

function toPaneInfo(raw: Record<string, unknown>): PaneInfo {
  const info: PaneInfo = {};
  for (const key of STRING_KEYS) {
    const v = raw[key];
    if (typeof v === "string") info[key] = v;
  }
  for (const key of NUMBER_KEYS) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) info[key] = v;
  }
  for (const key of BOOLEAN_KEYS) {
    const v = raw[key];
    if (typeof v === "boolean") info[key] = v;
  }
  const size = raw["size"];
  if (size !== null && typeof size === "object" && !Array.isArray(size)) {
    const s: PaneSize = {};
    for (const key of SIZE_NUMBER_KEYS) {
      const v = (size as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v)) s[key] = v;
    }
    info.size = s;
  }
  return info;
}

/**
 * 解析 `wezterm cli list --format json` stdout → PaneInfo[]。
 * - 字段缺失容错：任何字段缺失/类型不符都只表现为 undefined，绝不抛错（版本漂移防御）；
 * - 非对象条目跳过；
 * - 顶层不是数组或不是合法 JSON → 抛错（stdout 不是 list 输出，调用方视为 other 失败）。
 */
export function parseList(json: string): PaneInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`parseList: stdout 不是合法 JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(data)) {
    throw new Error("parseList: 期望 pane 数组（wezterm cli list --format json）");
  }
  const panes: PaneInfo[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    panes.push(toPaneInfo(entry as Record<string, unknown>));
  }
  return panes;
}

/**
 * 降级判定纯函数（spike §2/§9）：L1（GUI/mux 不可达）唯一判别 =
 * stderr 含 `failed to connect to Socket(`。exit code 不可用（L1 与运行时错误同为
 * exit 1）；clap 用法错误 exit 2 发生在连接前，与本函数无关。
 */
export function classifyCliFailure(stderr: string): DegradeVerdict {
  return L1_STDERR_PATTERN.test(stderr) ? "l1" : "other";
}
