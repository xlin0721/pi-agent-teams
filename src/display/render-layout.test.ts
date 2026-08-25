// src/display/render-layout.test.ts
// 票 04 渲染器布局单测（render-core.test.ts 拆分产物）：renderStatusText 状态条 +
// TerminalLayout 终端布局输出（DECSTBM 滚动区 / 光标出入区 / 全量重绘）。
// layout 全纯，零 I/O、不 spawn 真 pi。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalLayout, renderStatusText } from "./layout.ts";
import type { StatusModel } from "./types.ts";

const TASK_ID = "019ffbb9-f298-7e6d-9b56-a2dd1ce2751d";
const TASK_ID8 = TASK_ID.slice(0, 8);
test("renderStatusText：steer 被拒徽标（票 05）", () => {
  const withReason = renderStatusText(statusModel({ steerRejected: "EPIPE" }), 500);
  assert.ok(withReason.includes("⚠ steer 被拒: EPIPE"));
  const generic = renderStatusText(statusModel({ steerRejected: "（未给原因）" }), 500);
  assert.ok(generic.includes("⚠ steer 被拒"));
});
test("renderStatusText：steer 乐观「已发送」瞬态（票 06 追加）", () => {
  const sent = renderStatusText(statusModel({ steerSent: true }), 500);
  assert.ok(sent.includes("⏳ 已发送"));
  // 有排队数时优先显示排队，不显示已发送
  const queued = renderStatusText(statusModel({ steerSent: true, steerQueued: 2 }), 500);
  assert.ok(queued.includes("⏳ steer 排队 2"));
  assert.ok(!queued.includes("⏳ 已发送"));
});
function statusModel(over: Partial<StatusModel> = {}): StatusModel {
  return {
    taskId: TASK_ID,
    taskId8: TASK_ID8,
    role: "worker",
    phase: "回合 2",
    turn: 2,
    totalTokens: 4739,
    startedAt: 0,
    label: "运行中",
    steerQueued: 0,
    steerSent: false,
    steerClosed: false,
    steerRejected: null,
    badLines: 0,
    oversizeLines: 0,
    cwd: "",
    elapsedMs: 74_000,
    ...over,
  };
}
test("renderStatusText：宽态全段 + 窄 pane <40 列只留 taskId8+阶段（frontend#6）", () => {
  const wide = renderStatusText(statusModel(), 120);
  assert.ok(wide.includes(TASK_ID8));
  assert.ok(wide.includes("worker"));
  assert.ok(wide.includes("运行中"));
  assert.ok(wide.includes("回合 2"));
  assert.ok(wide.includes("tok 4739"));
  assert.ok(wide.includes("⏱ 1m14s"));
  const narrow = renderStatusText(statusModel(), 30);
  assert.equal(narrow, `${TASK_ID8} 回合 2`);
});
test("renderStatusText：steer 排队徽标/坏行巨行低位/warnings/裁剪与截断", () => {
  const m = statusModel({ steerQueued: 2, steerClosed: true, badLines: 1, oversizeLines: 1, cwd: "/very/long/cwd/path" });
  const text = renderStatusText(m, 500);
  assert.ok(text.includes("⏳ steer 排队 2"));
  assert.ok(text.includes("⚠ steer 通道关闭"));
  assert.ok(text.includes("⚠坏行 1"));
  assert.ok(text.includes("⚠巨行 1"));
  assert.ok(text.includes("/very/long/cwd/path"));
  // 超宽：cwd（最低优先级）先被裁
  const clipped = renderStatusText(m, 60);
  assert.ok(!clipped.includes("/very/long"));
  assert.ok(clipped.startsWith(TASK_ID8));
  // 极窄：最终截断
  const tiny = renderStatusText(m, 12);
  assert.equal(tiny.length, 12);
  assert.ok(tiny.endsWith("…"));
});
test("renderStatusText：role 空/回合 0/token 空段缺省", () => {
  const text = renderStatusText(statusModel({ role: "", turn: 0, totalTokens: null }), 200);
  assert.ok(!text.includes("│ │"));
  assert.ok(!text.includes("回合 0"));
  assert.ok(!text.includes("tok "));
});
test("TerminalLayout：DECSTBM 滚动区 2..rows-1 + 输入行在区域外（frontend#2）", () => {
  const l = new TerminalLayout({ rows: 10, cols: 40 });
  assert.equal(l.setup(), "\x1b[2J\x1b[H\x1b[2;9r");
  assert.equal(l.regionTop, 2);
  assert.equal(l.regionBottom, 9);
  assert.equal(l.regionHeight, 8);
  assert.equal(l.inputRow, 10); // 输入行 = 最底行，区域外
});
test("TerminalLayout：paintLines 入区写/出区回输入行纪律 + 区满滚动", () => {
  const l = new TerminalLayout({ rows: 5, cols: 40 });
  // 第一行 → 区顶 row2，写完出区到 row5
  assert.equal(l.paintLines([{ text: "a", kind: "assistant" }]), "\x1b[2;1H\x1b[2Ka\r\n\x1b[5;1H");
  assert.equal(l.paintLines([{ text: "b", kind: "assistant" }]), "\x1b[3;1H\x1b[2Kb\r\n\x1b[5;1H");
  // 底行（row4=regionBottom）：不带尾 \n（评审 R#1：regionBottom 的 \n 触发区滚动丢行）
  assert.equal(l.paintLines([{ text: "c", kind: "assistant" }]), "\x1b[4;1H\x1b[2Kc\x1b[5;1H");
  // 区满（regionHeight=3）：先 \n 滚动清出底行，再写文本
  assert.equal(l.paintLines([{ text: "d", kind: "assistant" }]), "\x1b[4;1H\n\x1b[4;1H\x1b[2Kd\x1b[5;1H");
  assert.equal(l.paintLines([{ text: "e", kind: "assistant" }]), "\x1b[4;1H\n\x1b[4;1H\x1b[2Ke\x1b[5;1H");
});
test("TerminalLayout：paintStatus 写 row1 出区；rows<3 退化", () => {
  const l = new TerminalLayout({ rows: 10, cols: 40 });
  assert.equal(l.paintStatus("S"), "\x1b[1;1H\x1b[2KS\x1b[10;1H");
  const small = new TerminalLayout({ rows: 2, cols: 40 });
  assert.equal(small.paintStatus("S"), ""); // 无独立状态行
  assert.equal(small.setup(), "\x1b[2J\x1b[H\x1b[r");
  assert.equal(small.regionTop, 1);
  assert.equal(small.inputRow, 2);
});
test("TerminalLayout：repaint 重设滚动区 + 状态条 + 区域清空 + 尾部可见行（SIGWINCH 前三件套）", () => {
  const l = new TerminalLayout({ rows: 6, cols: 40 });
  const out = l.repaint("STATUS", [
    { text: "old1", kind: "assistant" },
    { text: "old2", kind: "assistant" },
    { text: "old3", kind: "assistant" },
    { text: "old4", kind: "assistant" },
    { text: "new", kind: "assistant" },
  ]);
  assert.ok(out.startsWith("\x1b[2;5r")); // 重设滚动区
  assert.ok(out.includes("\x1b[1;1H\x1b[2KSTATUS")); // 状态条重绘
  for (let r = 2; r <= 5; r++) assert.ok(out.includes(`\x1b[${r};1H\x1b[2K`)); // 区域清空
  assert.ok(out.includes("old3") && out.includes("new")); // 尾部 regionHeight 条
  assert.ok(!out.includes("old1")); // 头部滚出
  assert.ok(out.endsWith("\x1b[6;1H")); // 出区到输入行
});
