// src/display/protocol.test.ts
// 只断言外部行为：parseList 对 spike-facts §1 真实样本 / 字段缺失 / 类型漂移的纯解析，
// classifyCliFailure 对 L1 stderr 原文（spike §2）与运行时错误 stderr（spike §6/§9）的判定。
// 零 I/O：不碰真实 wezterm cli。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseList, classifyCliFailure } from "./protocol.ts";
import type { PaneInfo } from "./protocol.ts";

/** spike-facts §1 真实样本（list --format json 单条目全字段，脱敏路径原文）。 */
const REAL_SAMPLE = `[
{
    "window_id": 0,
    "tab_id": 0,
    "pane_id": 0,
    "workspace": "default",
    "size": {
        "rows": 53,
        "cols": 272,
        "pixel_width": 5984,
        "pixel_height": 3286,
        "dpi": 144
    },
    "title": "π - pi-agent-teams",
    "cwd": "file:///path/to/project/",
    "cursor_x": 0,
    "cursor_y": 49,
    "cursor_shape": "Default",
    "cursor_visibility": "Hidden",
    "left_col": 0,
    "top_row": 0,
    "tab_title": "",
    "window_title": "user@host: ~/path",
    "is_active": true,
    "is_zoomed": false,
    "tty_name": "/dev/ttysNNN"
}
]`;

/** spike §2 L1 stderr 原文（140 字节，仅时间戳可变）。 */
const L1_STDERR = `15:14:46.175  ERROR  wezterm > failed to connect to Socket("/tmp/bogus-nonexist.sock"): connecting to /tmp/bogus-nonexist.sock; terminating`;

/** spike §6 运行时错误 stderr（kill 不存在 pane，exit 1 但与 L1 不同）。 */
const NO_SUCH_PANE_STDERR = `ERROR wezterm > unexpected response Ok(ErrorResponse(… "Error: no such pane 999")); terminating`;

test("parseList: spike §1 真实样本全字段解析", () => {
  const panes = parseList(REAL_SAMPLE);
  assert.equal(panes.length, 1);
  const p = panes[0]!;
  assert.equal(p.window_id, 0);
  assert.equal(p.tab_id, 0);
  assert.equal(p.pane_id, 0);
  assert.equal(p.workspace, "default");
  assert.deepEqual(p.size, { rows: 53, cols: 272, pixel_width: 5984, pixel_height: 3286, dpi: 144 });
  assert.equal(p.title, "π - pi-agent-teams");
  assert.equal(p.cwd, "file:///path/to/project/");
  assert.equal(p.cursor_x, 0);
  assert.equal(p.cursor_y, 49);
  assert.equal(p.cursor_shape, "Default");
  assert.equal(p.cursor_visibility, "Hidden");
  assert.equal(p.left_col, 0);
  assert.equal(p.top_row, 0);
  assert.equal(p.tab_title, "");
  assert.equal(p.window_title, "user@host: ~/path");
  assert.equal(p.is_active, true);
  assert.equal(p.is_zoomed, false);
  assert.equal(p.tty_name, "/dev/ttysNNN");
});

test("parseList: 多条目（spike 基线 [(0,0,0),(0,1,1)]）按序解析", () => {
  const panes = parseList(`[
    {"window_id":0,"tab_id":0,"pane_id":0,"title":"a"},
    {"window_id":0,"tab_id":1,"pane_id":1,"title":"b"}
  ]`);
  assert.equal(panes.length, 2);
  assert.equal(panes[0]!.pane_id, 0);
  assert.equal(panes[1]!.pane_id, 1);
  assert.equal(panes[1]!.title, "b");
});

test("parseList: 字段缺失容错——只有 window_id/pane_id 也能解析，其余 undefined", () => {
  const panes = parseList(`[{"window_id":2,"pane_id":7}]`);
  assert.equal(panes.length, 1);
  const p = panes[0]!;
  assert.equal(p.window_id, 2);
  assert.equal(p.pane_id, 7);
  assert.equal(p.tab_id, undefined);
  assert.equal(p.title, undefined);
  assert.equal(p.cwd, undefined);
  assert.equal(p.size, undefined);
  assert.equal(p.is_active, undefined);
  assert.equal(p.tty_name, undefined);
});

test("parseList: 空条目对象 → 全 undefined，不抛错", () => {
  const panes = parseList(`[{}]`);
  assert.equal(panes.length, 1);
  const p = panes[0]!;
  assert.equal(p.pane_id, undefined);
  assert.equal(p.window_id, undefined);
});

test("parseList: 未知新增字段忽略（未来版本加字段不炸）", () => {
  const panes = parseList(`[{"pane_id":1,"future_field":{"x":1},"z_index":9}]`);
  assert.equal(panes.length, 1);
  assert.equal(panes[0]!.pane_id, 1);
  assert.equal(Object.keys(panes[0]!).length, 1);
});

test("parseList: 类型漂移防御——字段改型不拷贝、不抛错", () => {
  const panes = parseList(
    `[{"pane_id":"9","title":42,"is_active":"yes","size":{"rows":"53"}}]`,
  );
  assert.equal(panes.length, 1);
  const p = panes[0]!;
  assert.equal(p.pane_id, undefined); // string 不拷贝
  assert.equal(p.title, undefined); // number 不拷贝
  assert.equal(p.is_active, undefined); // string 不拷贝
  assert.deepEqual(p.size, {}); // size 内 rows 为 string 不拷贝
});

test("parseList: 非对象条目跳过（漂移防御）", () => {
  const panes = parseList(`[{"pane_id":1}, null, "junk", 42, [1,2]]`);
  assert.equal(panes.length, 1);
  assert.equal(panes[0]!.pane_id, 1);
});

test("parseList: 空数组 → []", () => {
  assert.deepEqual(parseList("[]"), []);
});

test("parseList: 空串/非法 JSON → 抛错（调用方视为 other 失败）", () => {
  assert.throws(() => parseList(""), /不是合法 JSON/);
  assert.throws(() => parseList("not-json"), /不是合法 JSON/);
});

test("parseList: 顶层不是数组 → 抛错（如 default table 格式输出）", () => {
  assert.throws(() => parseList(`{"pane_id":1}`), /期望 pane 数组/);
});

test("classifyCliFailure: spike §2 L1 stderr 原文 → l1", () => {
  assert.equal(classifyCliFailure(L1_STDERR), "l1");
});

test("classifyCliFailure: 空 stderr → other（L1 时 stderr 必有该行，空 stderr 非 L1 证据）", () => {
  assert.equal(classifyCliFailure(""), "other");
});

test("classifyCliFailure: 运行时错误 stderr → other（exit code 同为 1 不可区分，spike §9）", () => {
  assert.equal(classifyCliFailure(NO_SUCH_PANE_STDERR), "other");
  assert.equal(
    classifyCliFailure("ERROR wezterm > unable to resolve current tab; terminating"),
    "other",
  );
});

test("classifyCliFailure: 仅部分匹配不误判（前后缀严格在模式内）", () => {
  assert.equal(classifyCliFailure("some failed to connect to Socket(/tmp/x.sock) noise"), "l1");
  assert.equal(classifyCliFailure("failed to connect to Socket"), "other"); // 缺 "(" 不命中（模式严格对齐 spike 原文）
  assert.equal(classifyCliFailure("failed to connect to socket("), "other"); // 大小写不符
  assert.equal(classifyCliFailure("unexpected response Ok(ErrorResponse(failed to connect))"), "other");
});

test("类型签名自检：PaneInfo 全字段为 optional（版本漂移防御的编译期保证）", () => {
  const p: PaneInfo = {};
  assert.equal(p.pane_id, undefined);
});
