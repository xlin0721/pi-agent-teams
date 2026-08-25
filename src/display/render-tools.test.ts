// src/display/render-tools.test.ts
// 票 04 渲染器工具摘要单测（render-core.test.ts 拆分产物）：formatToolArgs /
// formatToolResult（截 200 + 剥 ANSI + 折叠空白）。tools 全纯，零 I/O。
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToolArgs, formatToolResult } from "./tools.ts";

test("formatToolArgs/formatToolResult：截 200 + 剥 ANSI + 折叠空白", () => {
  const longCmd = "echo " + "y".repeat(300);
  const args = formatToolArgs({ command: longCmd });
  assert.equal(args.length, 200);
  assert.ok(args.endsWith("…"));
  assert.equal(formatToolArgs({ command: "sleep \x1b[31m8" }), "sleep 8");
  assert.equal(formatToolResult({ content: [{ type: "text", text: "WAKE\n" }] }), "WAKE");
  assert.equal(formatToolResult({ content: [{ type: "text", text: "line1\n  line2" }] }), "line1 line2");
  const r = formatToolResult({ content: [{ type: "text", text: "z".repeat(300) }] });
  assert.equal(r.length, 200);
  assert.ok(r.endsWith("…"));
});
