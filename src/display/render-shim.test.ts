// src/display/render-shim.test.ts
// 票 04 渲染器 IO/pipe 集成单测（render-core.test.ts 拆分产物）：StringDecoder 合帧
// / 超宽折行 / 首屏 sanitize / injectSystemLine + 假 pi shim（真 spawn node -e，
// 不 spawn 真 pi）pipe 全链路。输出只走注入的 output，渲染器零进程副作用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { Buffer } from "node:buffer";
import { runRenderer } from "./render-core.ts";
import type { PiChild, ReadableLike, WritableLike } from "./render-core.ts";

const TASK_ID = "019ffbb9-f298-7e6d-9b56-a2dd1ce2751d";
const PROMPT =
  "Use the bash tool to run this single command exactly: `sleep 8 && echo WAKE`. Do not run any other command. After it finishes, reply with exactly the word DONE and nothing else.";

function ev(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...fields });
}

function msgStart(role: string, text: string): string {
  return ev("message_start", {
    message: { role, content: text === "" ? [] : [{ type: "text", text }] },
  });
}

function msgEnd(role: string, text: string, usage?: unknown): string {
  const message: Record<string, unknown> = { role, content: [{ type: "text", text }] };
  if (usage !== undefined) message["usage"] = usage;
  return ev("message_end", { message });
}

function delta(kind: string, d: string): string {
  return ev("message_update", { assistantMessageEvent: { type: kind, contentIndex: 0, delta: d } });
}

function textEnd(content: string): string {
  return ev("message_update", { assistantMessageEvent: { type: "text_end", contentIndex: 0, content } });
}

interface FakeChild extends PiChild {
  __stdinWrites: string[];
  __emitExit(code: number | null, signal: string | null): void;
  __emitError(err: unknown): void;
  __emitStdinError(err: unknown): void;
}

function makeFakeChild(opts: { failNextWriteWith?: string } = {}): FakeChild {
  const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  const errorCbs: Array<(err: unknown) => void> = [];
  let stdinErrorCb: ((err: unknown) => void) | null = null;
  const writes: string[] = [];
  const stdin: WritableLike = {
    write: (chunk: string, cb?: (err?: unknown) => void) => {
      writes.push(chunk);
      if (opts.failNextWriteWith !== undefined) {
        const msg = opts.failNextWriteWith;
        opts.failNextWriteWith = undefined;
        cb?.(new Error(msg));
      } else {
        cb?.(undefined);
      }
      return true;
    },
    on: (event: string, cb: (err: unknown) => void) => {
      if (event === "error") stdinErrorCb = cb;
      return undefined;
    },
  };
  const child: FakeChild = {
    pid: 4242,
    stdin,
    stdout: {
      on: () => undefined,
    },
    kill: () => undefined,
    on: (event: string, listener: ((code: number | null, signal: string | null) => void) | ((err: unknown) => void)) => {
      if (event === "exit") {
        exitCbs.push(listener as (code: number | null, signal: string | null) => void);
      }
      if (event === "error") errorCbs.push(listener as (err: unknown) => void);
      return undefined;
    },
    __stdinWrites: writes,
    __emitExit: (code, signal) => {
      for (const cb of exitCbs) cb(code, signal);
    },
    __emitError: (err) => {
      for (const cb of errorCbs) cb(err);
    },
    __emitStdinError: (err) => {
      stdinErrorCb?.(err);
    },
  };
  return child;
}
function fixtureStream(chunks: string[]): ReadableLike {
  const r = new Readable({ read() {} });
  for (const c of chunks) r.push(c + "\n");
  r.push(null);
  return r as unknown as ReadableLike;
}

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(() => res(), ms));

function rendererOpts(over: Record<string, unknown> = {}): {
  taskId: string;
  role: string;
  prompt: string;
  startedAt: number;
  getSize: () => { rows: number; cols: number };
  now: () => number;
  flushMs: number;
  statusThrottleMs: number;
  elapsedTickMs: number;
  appendScroll?: boolean;
  onBottomRow?: () => void;
} {
  return {
    taskId: TASK_ID,
    role: "worker",
    prompt: PROMPT,
    startedAt: 0,
    getSize: () => ({ rows: 12, cols: 100 }),
    now: () => 2_000_000,
    flushMs: 1,
    statusThrottleMs: 5,
    elapsedTickMs: 10_000, // 测试期不 tick（终态 paint 直接驱动）
    ...over,
  };
}

function captureOutput(): { out: WritableLike; text(): string } {
  let text = "";
  const out: WritableLike = {
    write: (s: string) => {
      text += s;
      return true;
    },
  };
  return { out, text: () => text };
}

test("runRenderer：多字节 UTF-8 跨 chunk 边界不损坏（StringDecoder）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const events = [
    ev("agent_start"),
    msgStart("assistant", ""),
    ev("message_update", { assistantMessageEvent: { type: "text_delta", delta: "你好" } }),
    msgEnd("assistant", "你好"),
  ];
  const full = Buffer.from(events.map((e) => e + "\n").join(""), "utf8");
  const idx = full.indexOf(Buffer.from("你", "utf8"));
  assert.ok(idx >= 0, "fixture 应含「你」");
  const r = new Readable({ read() {} });
  r.push(full.subarray(0, idx + 1)); // 「你」的第 1 字节后劈开
  r.push(full.subarray(idx + 1));
  r.push(null);
  const handle = runRenderer(
    { input: r as unknown as ReadableLike, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts({ prompt: "P" }),
  );
  setTimeout(() => child.__emitExit(0, null), 30);
  assert.equal(await handle.done, 0);
  const text = captured.text();
  assert.ok(text.includes("你好"), "跨 chunk 多字节应正确续拼");
  assert.ok(!text.includes("�"), "不得出现替换字符");
});
test("runRenderer：EOF 残半字节 flush 不崩（StringDecoder）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const r = new Readable({ read() {} });
  r.push(Buffer.concat([Buffer.from(ev("agent_start") + "\n", "utf8"), Buffer.from([0xe4])])); // 「你」的首字节
  r.push(null);
  const handle = runRenderer(
    { input: r as unknown as ReadableLike, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts(),
  );
  setTimeout(() => child.__emitExit(0, null), 30);
  assert.equal(await handle.done, 0); // done 正常，不抛
});
test("runRenderer：超宽折行 fixture（窄 pane 长行折行视觉行 ≤ cols）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const long = "x".repeat(80);
  const handle = runRenderer(
    {
      input: fixtureStream([
        msgStart("assistant", ""),
        ev("message_update", { assistantMessageEvent: { type: "text_delta", delta: long } }),
        msgEnd("assistant", long),
      ]),
      output: captured.out,
      spawnPi: () => child,
      onResize: () => {},
    },
    rendererOpts({ prompt: "P", getSize: () => ({ rows: 12, cols: 20 }) }),
  );
  setTimeout(() => child.__emitExit(0, null), 30);
  assert.equal(await handle.done, 0);
  const text = captured.text();
  assert.ok(!text.includes(long), "80 列长行不得整行上屏（应折行为 ≤20 列视觉行）");
  assert.ok((text.match(/x{20}/g) ?? []).length >= 4, "折行后应有 4 条 20 列片段");
});
test("runRenderer：taskId/role/prompt 含 ANSI/控制符首屏不泄漏注入面", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts({
      taskId: "x\x1b]0;evil\x07y",
      role: "\x1b[32mro",
      prompt: "p\x1b[35mrompt",
    }),
  );
  child.__emitExit(0, null);
  assert.equal(await handle.done, 0);
  const text = captured.text();
  assert.ok(!text.includes("evil"), "OSC 注入内容不得泄漏");
  assert.ok(!text.includes("\x1b]0;evil"));
  assert.ok(!text.includes("\x1b[32m"), "role 的 ANSI 不得泄漏");
  assert.ok(!text.includes("\x1b[35m"), "prompt 的 ANSI 不得泄漏");
  assert.ok(text.includes("任务 xy"), "taskId 剥净后进首屏");
  assert.ok(text.includes("📋 prompt"), "prompt 剥净后进首屏预览");
  // 初始 prompt 注入走剥净后的 safePrompt（边界 sanitize 喂注入）
  assert.equal(child.__stdinWrites[0], `${JSON.stringify({ type: "prompt", message: "prompt" })}\n`);
});
test("runRenderer：taskId/role/prompt 含 ESC+非 Fe 单字符序列首屏不泄漏（票 09 #5 修复）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts({
      taskId: "t\x1b7k",
      role: "\x1b#8ro",
      prompt: "p\x1b7rompt",
    }),
  );
  child.__emitExit(0, null);
  assert.equal(await handle.done, 0);
  const text = captured.text();
  assert.ok(!text.includes("\x1b7"), "DECSC（ESC 7）不得泄漏到捕获输出");
  assert.ok(!text.includes("\x1b#8"), "DECALN（ESC # 8）不得泄漏到捕获输出");
  assert.ok(text.includes("任务 t7k"), "taskId 剥净后进首屏");
  // 初始 prompt 注入走剥净后的 safePrompt（边界 sanitize 喂注入）
  assert.equal(child.__stdinWrites[0], `${JSON.stringify({ type: "prompt", message: "p7rompt" })}\n`);
});
test("runRenderer：injectSystemLine 无数据事件仍上屏（FE#2）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts({ flushMs: 1 }),
  );
  handle.injectSystemLine("📨 来自 main: hi");
  await delay(10);
  assert.ok(captured.text().includes("📨 来自 main: hi"), "无数据事件时 notice 仍应上屏");
  child.__emitExit(0, null);
  assert.equal(await handle.done, 0);
});
const SHIM_FIXTURE = [
  ev("agent_start"),
  ev("turn_start"),
  msgStart("user", "do the thing"),
  msgEnd("user", "do the thing"),
  msgStart("assistant", ""),
  delta("text_delta", "SHIM-"),
  delta("text_delta", "OUTPUT"),
  textEnd("SHIM-OUTPUT"),
  msgEnd("assistant", "SHIM-OUTPUT", { totalTokens: 42 }),
  ev("turn_end", { message: { role: "assistant", usage: { totalTokens: 42 } } }),
  ev("agent_end", { messages: [], willRetry: false }),
  ev("agent_settled"),
];

test("假 pi shim 集成：pipe 全链路回放 fixture 后 exit(3) → done=3", async () => {
  const shimSrc = `
    const lines = ${JSON.stringify(SHIM_FIXTURE)};
    process.stdin.resume();
    setTimeout(() => { for (const l of lines) process.stdout.write(l + "\\n"); }, 15);
    setTimeout(() => process.exit(3), 60);
  `;
  const shim = spawn(process.execPath, ["-e", shimSrc], { stdio: ["pipe", "pipe", "ignore"] });
  const captured = captureOutput();
  const handle = runRenderer(
    {
      input: null,
      output: captured.out,
      spawnPi: () => shim as unknown as PiChild,
      onResize: () => {},
    },
    rendererOpts({ prompt: "do the thing", getSize: () => ({ rows: 10, cols: 60 }) }),
  );
  const code = await handle.done;
  assert.equal(code, 3);
  const text = captured.text();
  assert.ok(text.includes("\x1b[2;9r")); // rows=10 滚动区
  assert.ok(text.includes("SHIM-OUTPUT"));
  assert.ok(text.includes("▶ 已结束（agent_settled）"));
  assert.ok(text.includes("已退出（码 3）")); // 终态
});
test("假 pi shim 集成：shim 自 SIGTERM → done=143（128+n）", async () => {
  const shimSrc = `
    process.stdin.resume();
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
  `;
  const shim = spawn(process.execPath, ["-e", shimSrc], { stdio: ["pipe", "pipe", "ignore"] });
  const captured = captureOutput();
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => shim as unknown as PiChild, onResize: () => {} },
    rendererOpts({ prompt: "x", elapsedTickMs: 10 }),
  );
  assert.equal(await handle.done, 143);
});
test("假 pi shim 交互：读 stdin 收 steer → response/queue/turn/回显（票 05 集成）", async () => {
  const shimSrc = `
    process.stdin.setEncoding("utf8");
    let buf = "";
    const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === "") continue;
        let cmd;
        try { cmd = JSON.parse(line); } catch { continue; }
        if (cmd.type !== "steer") continue;
        const m = cmd.message;
        out({ type: "response", command: "steer", success: true });
        out({ type: "queue_update", steering: [m], followUp: [] });
        out({ type: "turn_start" });
        out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: m }] } });
        out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: m }] } });
        out({ type: "queue_update", steering: [], followUp: [] });
      }
    });
    setTimeout(() => process.exit(0), 400);
  `;
  const shim = spawn(process.execPath, ["-e", shimSrc], { stdio: ["pipe", "pipe", "ignore"] });
  const captured = captureOutput();
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => shim as unknown as PiChild, onResize: () => {} },
    rendererOpts({ prompt: "initial", getSize: () => ({ rows: 10, cols: 60 }) }),
  );
  handle.injectUserMessage("fix-this");
  assert.equal(await handle.done, 0);
  const text = captured.text();
  assert.ok(text.includes("👤 fix-this"), "steer 以 user 消息回显（spike §S4）");
  assert.ok(text.includes("回合 1"), "turn_start 触发新回合");
});
