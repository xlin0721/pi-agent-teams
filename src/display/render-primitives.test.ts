// src/display/render-primitives.test.ts
// 票 04 渲染器原语单测（render-core.test.ts 拆分产物）：LineFramer 合帧 /
// AnsiStripper ANSI 剥除 / 折行（wrapText/charWidth）/ 文本原语
// （collapseWhitespace/truncateTo）。primitives 全纯，零 I/O、不 spawn 真 pi。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnsiStripper,
  LineFramer,
  MAX_LINE_CHARS,
  charWidth,
  collapseWhitespace,
  stripAnsiText,
  truncateTo,
  wrapText,
} from "./primitives.ts";

test("LineFramer：\\n 分割跨 chunk 边界 + strip 尾部 \\r", () => {
  const f = new LineFramer();
  assert.deepEqual(f.feed("a\nb"), ["a"]); // 跨 chunk：b 挂起
  assert.deepEqual(f.feed("c\r\nd"), ["bc"]); // b+c 完整，尾部 \r 剥除；d 挂起
  assert.deepEqual(f.feed("\n"), ["d"]); // d 完整
  assert.equal(f.oversizeLines, 0);
});

test("LineFramer：U+2028/2029 在 JSON 字符串内不切分（rpc.md framing 纪律）", () => {
  const f = new LineFramer();
  const line = JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a\u2028b\u2029c" } });
  const out = f.feed(line + "\nnext\n");
  assert.equal(out.length, 2);
  assert.equal(out[0], line);
  assert.equal(out[1], "next");
});

test("LineFramer：单行 >1MiB 截断 + 计数（后续碎片不入缓冲）", () => {
  const f = new LineFramer();
  const big = "x".repeat(MAX_LINE_CHARS + 10);
  const out = f.feed(big + "\nok\n");
  assert.equal(out.length, 2);
  assert.equal(out[0]!.length, MAX_LINE_CHARS);
  assert.equal(out[1], "ok");
  assert.equal(f.oversizeLines, 1);
  // 无 \\n 的巨行：pending 封顶，后续内容丢弃直到换行
  const f2 = new LineFramer();
  assert.deepEqual(f2.feed("y".repeat(MAX_LINE_CHARS + 500)), []);
  const out2 = f2.feed("tail\n");
  assert.equal(out2.length, 1);
  assert.equal(out2[0]!.length, MAX_LINE_CHARS);
  assert.equal(f2.oversizeLines, 1);
});
test("AnsiStripper：SGR 完整序列剥除", () => {
  assert.equal(stripAnsiText("\x1b[31mred\x1b[0m"), "red");
  assert.equal(stripAnsiText("\x1b[1;33m\u001b[0m"), "");
  assert.equal(stripAnsiText("a\x1b[31mb\x1b[0mc"), "abc");
});

test("AnsiStripper：跨 delta 劈开的转义序列续拼（frontend#3 fixture）", () => {
  const s = new AnsiStripper();
  assert.equal(s.feed("\x1b[3"), ""); // delta 边界劈开 CSI
  assert.equal(s.feed("1mCOLOR\x1b[0m"), "COLOR"); // 下一 delta 续拼完成
  assert.equal(s.feed(" plain"), " plain");
  assert.equal(s.flush(), "");
});

test("AnsiStripper：ESC 与参数逐字符劈开续拼", () => {
  const s = new AnsiStripper();
  assert.equal(s.feed("\x1b"), "");
  assert.equal(s.feed("["), "");
  assert.equal(s.feed("31"), "");
  assert.equal(s.feed("m"), "");
  assert.equal(s.feed("Y\x1b[0m"), "Y");
});

test("AnsiStripper：OSC（BEL 与 ST 双终止）/ DCS / C1", () => {
  assert.equal(stripAnsiText("\x1b]0;title\x07abc"), "abc");
  assert.equal(stripAnsiText("\x1b]0;title\x1b\\abc"), "abc");
  assert.equal(stripAnsiText("\x1bP1$tst\x1b\\after"), "after");
  assert.equal(stripAnsiText("\x1bcRIS"), "RIS"); // C1：ESC c 完整剥除
});

test("AnsiStripper：OSC 内容跨 feed 无界不暂存", () => {
  const s = new AnsiStripper();
  assert.equal(s.feed("\x1b]0;" + "z".repeat(5000)), "");
  assert.equal(s.feed("tail\x07end"), "end");
});

test("AnsiStripper：C0 控制字符剥除（\\n \\t 保留）+ DEL", () => {
  assert.equal(stripAnsiText("a\x00b\x01c\x7fd"), "abcd");
  assert.equal(stripAnsiText("a\r\nb\tc"), "a\nb\tc");
});

test("AnsiStripper：reset 丢弃未闭合垃圾；flush 照发暂存", () => {
  const s = new AnsiStripper();
  s.feed("\x1b[31");
  assert.equal(s.flush(), "\x1b[31"); // 流结束照发
  const s2 = new AnsiStripper();
  s2.feed("\x1b[31");
  s2.reset(); // message 边界：未闭合=垃圾
  assert.equal(s2.feed("x"), "x");
});

test("AnsiStripper：非法组合照发保底（ESC+普通字符 / CSI 非法字节）", () => {
  // ESC + 普通字符（非转义序列终字节）→ 照发
  assert.equal(stripAnsiText("\x1bh"), "\x1bh");
  // CSI 参数后非法字节（DEL 0x7F，非参数/中间/终字节）→ 整段照发
  assert.equal(stripAnsiText("\x1b[1\x7f"), "\x1b[1\x7f");
});
test("wrapText：宽字符/emoji/组合符宽度感知折行", () => {
  assert.deepEqual(wrapText("abcdefghijk", 5), ["abcde", "fghij", "k"]);
  // 中文 2 列：宽度 4 一行两个
  assert.deepEqual(wrapText("你好世界", 4), ["你好", "世界"]);
  // emoji 2 列
  assert.deepEqual(wrapText("ab😀c", 3), ["ab", "😀c"]);
  // 组合符 0 列
  assert.equal(charWidth("e"), 1);
  assert.equal(charWidth("\u0301"), 0);
  assert.equal(charWidth("你"), 2);
  assert.equal(charWidth("😀"), 2);
});

test("wrapText：tab 8 列制表 + 防御性 \\n 切分", () => {
  assert.deepEqual(wrapText("a\tb", 10), ["a       b"]);
  assert.deepEqual(wrapText("x\n", 10), ["x"]);
  assert.deepEqual(wrapText("", 10), []);
});
test("collapseWhitespace/truncateTo 边界", () => {
  assert.equal(collapseWhitespace("a\n  b\tc"), "a b c");
  assert.equal(truncateTo("abcdef", 6), "abcdef");
  assert.equal(truncateTo("abcdef", 4), "abc…");
  assert.equal(truncateTo("abcdef", 0), "");
  assert.equal(truncateTo("abcdef", 1), "a");
});
