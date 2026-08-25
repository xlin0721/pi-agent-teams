// src/display/input.test.ts
// 票 05：输入行接线单测（fake rl 工厂注入，零 node:readline 依赖）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireFixedInputLine, wireInputLine } from "./input.ts";
import type { ReadlineLike } from "./input.ts";

function makeFakeRl() {
  const lineCbs: Array<(line: string) => void> = [];
  const sigintCbs: Array<() => void> = [];
  const promptCalls: boolean[] = [];
  let closed = false;
  const rl = {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === "line") lineCbs.push(listener as (line: string) => void);
      if (event === "SIGINT") sigintCbs.push(listener as () => void);
      return undefined;
    },
    prompt: (preserveCursor?: boolean) => {
      promptCalls.push(preserveCursor === true);
    },
    setPrompt: () => {},
    close: () => {
      closed = true;
    },
  } as ReadlineLike;
  return { rl, lineCbs, sigintCbs, promptCalls, getClosed: () => closed };
}

test("wireInputLine：isTTY 假 → 返回 null，createInterface 不被调用（直启降级）", () => {
  let created = 0;
  const handle = wireInputLine({
    isTTY: false,
    createInterface: () => {
      created++;
      return makeFakeRl().rl;
    },
    onLine: () => {},
    onAbort: () => {},
  });
  assert.equal(handle, null);
  assert.equal(created, 0);
});

test("wireInputLine：真 → createInterface 收 {terminal:true, prompt}；prompt 走 rl.prompt(true)", () => {
  const captured: Array<{ terminal: boolean; prompt: string }> = [];
  const fake = makeFakeRl();
  const handle = wireInputLine({
    isTTY: true,
    createInterface: (o) => {
      captured.push(o);
      return fake.rl;
    },
    onLine: () => {},
    onAbort: () => {},
  });
  assert.ok(handle);
  assert.deepEqual(captured, [{ terminal: true, prompt: "steer> " }]);
  handle!.prompt();
  assert.deepEqual(fake.promptCalls, [true]); // rl.prompt(true) 重绘
});

test("wireInputLine：line 事件 → onLine 收到原行（多行粘贴逐行触发）", () => {
  const fake = makeFakeRl();
  const lines: string[] = [];
  wireInputLine({
    isTTY: true,
    createInterface: () => fake.rl,
    onLine: (l) => lines.push(l),
    onAbort: () => {},
  });
  fake.lineCbs[0]!("steer me");
  fake.lineCbs[0]!("again");
  assert.deepEqual(lines, ["steer me", "again"]);
});

test("wireInputLine：SIGINT → onAbort 恰一次（连按两次 ctrl+C 幂等）", () => {
  const fake = makeFakeRl();
  let aborts = 0;
  wireInputLine({
    isTTY: true,
    createInterface: () => fake.rl,
    onLine: () => {},
    onAbort: () => aborts++,
  });
  fake.sigintCbs[0]!();
  fake.sigintCbs[0]!();
  assert.equal(aborts, 1);
});

test("wireInputLine：SIGINT 后 line 事件被忽略（abort 态不再提交）", () => {
  const fake = makeFakeRl();
  const lines: string[] = [];
  wireInputLine({
    isTTY: true,
    createInterface: () => fake.rl,
    onLine: (l) => lines.push(l),
    onAbort: () => {},
  });
  fake.sigintCbs[0]!();
  fake.lineCbs[0]!("after-abort");
  assert.deepEqual(lines, []);
});

test("wireInputLine：close 转 rl.close", () => {
  const fake = makeFakeRl();
  const handle = wireInputLine({
    isTTY: true,
    createInterface: () => fake.rl,
    onLine: () => {},
    onAbort: () => {},
  });
  handle!.close();
  assert.equal(fake.getClosed(), true);
});

// ── wireFixedInputLine 单测（票 09 #7 阶段 B：固定底部输入行降级） ──────────

function makeFixedHarness(cols = 20, rows = 12) {
  let keyCb: ((chunk: string) => void) | null = null;
  let unsubscribed = 0;
  let out = "";
  const lines: string[] = [];
  let aborts = 0;
  const handle = wireFixedInputLine({
    isTTY: true,
    onKey: (cb) => {
      keyCb = cb;
      return () => {
        unsubscribed++;
        keyCb = null;
      };
    },
    write: (s) => {
      out += s;
    },
    getSize: () => ({ rows, cols }),
    onLine: (l) => lines.push(l),
    onAbort: () => aborts++,
  });
  return {
    feed: (s: string) => keyCb?.(s),
    out: () => out,
    lines: () => lines,
    aborts: () => aborts,
    unsubscribed: () => unsubscribed,
    handle,
  };
}

const BOTTOM = "\x1b[12;1H\x1b[2K";

test("wireFixedInputLine：isTTY 假 → 返回 null，onKey 不被调用（直启降级）", () => {
  let subscribed = 0;
  const handle = wireFixedInputLine({
    isTTY: false,
    onKey: () => {
      subscribed++;
      return () => {};
    },
    write: () => {},
    getSize: () => ({ rows: 12, cols: 20 }),
    onLine: () => {},
    onAbort: () => {},
  });
  assert.equal(handle, null);
  assert.equal(subscribed, 0);
});

test("wireFixedInputLine：初始渲染定位最底行 + prompt（绝对定位 \\x1b[<rows>;1H\\x1b[2K）", () => {
  const h = makeFixedHarness();
  assert.equal(h.out(), `${BOTTOM}steer> `);
});

test("wireFixedInputLine：可打印追加 + 每键重绘（单行无 \\n）", () => {
  const h = makeFixedHarness();
  h.feed("a");
  h.feed("bc"); // 粘贴多键一 chunk
  assert.equal(h.out(), `${BOTTOM}steer> ${BOTTOM}steer> a${BOTTOM}steer> abc`);
  assert.ok(!h.out().includes("\n"), "输入行渲染绝不换行（不触发终端折行）");
});

test("wireFixedInputLine：长行尾部截断显示（单行 ≤ cols，绝不折行）", () => {
  const h = makeFixedHarness(20, 12); // prompt 7 列 → 可用 13 列
  h.feed("x".repeat(30));
  assert.ok(h.out().endsWith(`${BOTTOM}steer> ${`x`.repeat(13)}`), "只显示尾部 13 列");
  assert.ok(!h.out().includes("x".repeat(14)), "任何渲染不得出现 ≥14 连续 x（≤ cols 截断）");
  assert.ok(!h.out().includes("\n"));
});

test("wireFixedInputLine：宽字符按显示宽度截断（CJK 宽 2，≤ cols 不折行）", () => {
  const h = makeFixedHarness(20, 12); // 可用 13 显示列 → 最多 6 个 CJK（12 列）
  h.feed("你".repeat(20));
  assert.ok(h.out().endsWith(`${BOTTOM}steer> ${`你`.repeat(6)}`), "只显示尾部 6 个 CJK");
  assert.ok(!h.out().includes("你".repeat(7)), "7 个 CJK=14 列 > 13 可用列，不得出现");
});

test("wireFixedInputLine：Backspace 0x7f 与 0x08 均删末字符（代理对/CJK 正确）", () => {
  const h = makeFixedHarness();
  h.feed("ab");
  h.feed("\x7f");
  assert.ok(h.out().endsWith(`${BOTTOM}steer> a`), "DEL 退格");
  h.feed("\x08");
  assert.ok(h.out().endsWith(`${BOTTOM}steer> `), "BS 退格");
  // CJK 退格按码点
  h.feed("你好");
  h.feed("\x7f");
  assert.ok(h.out().endsWith(`${BOTTOM}steer> 你`), "CJK 按码点退格");
});

test("wireFixedInputLine：Enter(\r 与 \n) → onLine 收到 buffer 并清空重绘", () => {
  const h = makeFixedHarness();
  h.feed("hi\r");
  assert.deepEqual(h.lines(), ["hi"]);
  assert.ok(h.out().endsWith(`${BOTTOM}steer> `), "提交后清空重绘空行");
  h.feed("yo\n");
  assert.deepEqual(h.lines(), ["hi", "yo"]);
  assert.ok(h.out().endsWith(`${BOTTOM}steer> `));
});

test("wireFixedInputLine：Ctrl+C(0x03) → onAbort 恰一次，后续键忽略", () => {
  const h = makeFixedHarness();
  h.feed("a");
  h.feed("\x03");
  assert.equal(h.aborts(), 1);
  h.feed("\x03");
  assert.equal(h.aborts(), 1, "连按两次 ctrl+C 幂等");
  h.feed("b\r");
  assert.deepEqual(h.lines(), [], "abort 后不再提交");
});

test("wireFixedInputLine：close 退订 onKey（之后键不再处理/渲染）", () => {
  const h = makeFixedHarness();
  h.handle!.close();
  assert.equal(h.unsubscribed(), 1);
  const before = h.out();
  h.feed("z");
  assert.equal(h.out(), before, "close 后键不再渲染");
});

test("wireFixedInputLine：prompt() 幂等重绘（不清 buffer）", () => {
  const h = makeFixedHarness();
  h.feed("ab");
  const before = h.out();
  h.handle!.prompt();
  assert.ok(h.out().endsWith(`${BOTTOM}steer> ab`), "prompt 重绘保留 buffer");
  assert.ok(h.out().length > before.length);
});
