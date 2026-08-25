// src/display/render-run.test.ts
// 票 04 渲染器装配单测（render-core.test.ts 拆分产物）：runRenderer 注入装配
// （首屏 / DECSTBM / prompt 注入 / 退出码 / steer 通道关闭 / 64K 上限 / 降级
// repaint）+ computeExitCode / CRASH_EXIT_CODE。全部走注入的 output/spawnPi/input
// 假件，零 I/O、不 spawn 真 pi。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { MAX_STEER_BYTES, computeExitCode, runRenderer } from "./render-core.ts";
import { CRASH_EXIT_CODE } from "./render-mini.ts";
import type { PiChild, ReadableLike, SpawnPi, WritableLike } from "./render-core.ts";

const TASK_ID = "019ffbb9-f298-7e6d-9b56-a2dd1ce2751d";
const TASK_ID8 = TASK_ID.slice(0, 8);

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

function toolStart(name: string, args: unknown): string {
  return ev("tool_execution_start", { toolCallId: "call_1", toolName: name, args });
}

function toolUpdate(name: string, partialResult: unknown): string {
  return ev("tool_execution_update", { toolCallId: "call_1", toolName: name, partialResult });
}

function toolEnd(name: string, result: unknown, isError: boolean): string {
  return ev("tool_execution_end", { toolCallId: "call_1", toolName: name, result, isError });
}

function queue(steering: unknown): string {
  return ev("queue_update", { steering, followUp: [] });
}

/** spike §S1/§S3 证据原文（m25-a2-full） */
const PROMPT =
  "Use the bash tool to run this single command exactly: `sleep 8 && echo WAKE`. Do not run any other command. After it finishes, reply with exactly the word DONE and nothing else.";
const STEER1 =
  "After the sleep command finishes, do not reply DONE. Reply with exactly the word STEERED-ONE and nothing else.";
const STEER2 =
  "After the sleep command finishes, do not reply DONE or STEERED-ONE. Reply with exactly the word STEERED-TWO and nothing else.";
const USAGE_4698 = { input: 85, output: 5, cacheRead: 4608, cacheWrite: 0, reasoning: 0, totalTokens: 4698 };
const USAGE_4739 = { input: 126, output: 5, cacheRead: 4608, cacheWrite: 0, reasoning: 0, totalTokens: 4739 };
function a2FullFixture(): string[] {
  return [
    ev("agent_start"),
    ev("turn_start"),
    msgStart("user", PROMPT),
    msgEnd("user", PROMPT),
    msgStart("assistant", ""),
    delta("toolcall_start", ""),
    delta("toolcall_delta", "{\""),
    delta("toolcall_delta", "command"),
    toolStart("bash", { command: "sleep 8 && echo WAKE" }),
    queue([STEER1]),
    toolUpdate("bash", { content: [] }),
    queue([STEER1, STEER2]),
    toolUpdate("bash", { content: [{ type: "text", text: "WAKE\n" }], details: {} }),
    queue([STEER2]),
    toolEnd("bash", { content: [{ type: "text", text: "WAKE\n" }] }, false),
    ev("turn_end", { message: { role: "assistant", usage: { totalTokens: 4652 } }, toolResults: [] }),
    ev("turn_start"),
    queue([]),
    msgStart("user", STEER1),
    msgEnd("user", STEER1),
    msgStart("assistant", ""),
    delta("text_start", ""),
    delta("text_delta", "STE"),
    delta("text_delta", "ER"),
    delta("text_delta", "ED"),
    delta("text_delta", "-"),
    delta("text_delta", "ONE"),
    textEnd("STEERED-ONE"),
    msgEnd("assistant", "STEERED-ONE", USAGE_4698),
    ev("turn_end", { message: { role: "assistant", usage: USAGE_4698 }, toolResults: [] }),
    ev("turn_start"),
    queue([]),
    msgStart("user", STEER2),
    msgEnd("user", STEER2),
    msgStart("assistant", ""),
    delta("text_start", ""),
    delta("text_delta", "STE"),
    delta("text_delta", "ER"),
    delta("text_delta", "ED"),
    delta("text_delta", "-T"),
    delta("text_delta", "WO"),
    textEnd("STEERED-TWO"),
    msgEnd("assistant", "STEERED-TWO", USAGE_4739),
    ev("turn_end", { message: { role: "assistant", usage: USAGE_4739 }, toolResults: [] }),
    ev("agent_end", { messages: [], willRetry: false }),
    ev("agent_settled"),
    queue(["Reply with exactly the word IDLE-REPLY and nothing else."]),
  ];
}
test("computeExitCode：码直取 / 信号死 128+n / 未知信号保守 128", () => {
  assert.equal(computeExitCode(0, null), 0);
  assert.equal(computeExitCode(3, null), 3);
  assert.equal(computeExitCode(null, "SIGTERM"), 143);
  assert.equal(computeExitCode(null, "SIGKILL"), 137);
  assert.equal(computeExitCode(null, "SIGINT"), 130);
  assert.equal(computeExitCode(null, null), 0);
  assert.equal(computeExitCode(null, "SIGFUTURE"), 128);
});
test("退出码常量：CRASH_EXIT_CODE = 134 = computeExitCode(null,'SIGABRT')", () => {
  assert.equal(CRASH_EXIT_CODE, 134);
  assert.equal(computeExitCode(null, "SIGABRT"), 134);
  assert.equal(CRASH_EXIT_CODE, computeExitCode(null, "SIGABRT"));
});
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

test("runRenderer：fixture 输入流全链路（首屏/DECSTBM/状态条/prompt 注入/退出码）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    {
      input: fixtureStream([...a2FullFixture()]),
      output: captured.out,
      spawnPi: () => child,
      onResize: () => {},
    },
    rendererOpts(),
  );
  // 输入消费完后再退（等 exit 事件）
  setTimeout(() => child.__emitExit(0, null), 30);
  assert.equal(await handle.done, 0);

  const text = captured.text();
  assert.ok(text.includes("\x1b[2;11r")); // DECSTBM rows=12
  assert.ok(text.includes("等待首个事件…")); // 首屏
  assert.ok(text.includes(`任务 ${TASK_ID}`));
  assert.ok(text.includes("📋 "));
  assert.ok(text.includes("🔧 bash: sleep 8 && echo WAKE"));
  assert.ok(text.includes("STEERED-TWO"));
  assert.ok(text.includes(TASK_ID8)); // 状态条
  assert.ok(text.includes("运行中"));
  assert.ok(text.includes("已结束"));
  // 初始 prompt 走 stdin 行协议（spike 定案 A2）
  assert.equal(child.__stdinWrites[0], `${JSON.stringify({ type: "prompt", message: PROMPT })}\n`);
});
test("runRenderer：空 prompt 不产生 sendCommand（TD3）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    {
      input: fixtureStream([]),
      output: captured.out,
      spawnPi: () => child,
      onResize: () => {},
    },
    rendererOpts({ prompt: "" }),
  );
  // 初始 prompt 注入在 runRenderer 内同步执行：空 prompt 应被守卫跳过
  assert.equal(child.__stdinWrites.length, 0);
  setTimeout(() => child.__emitExit(0, null), 10);
  assert.equal(await handle.done, 0);
});
test("runRenderer：settled→prompt 注入策略（spike §Q4 落码）+ steer 排队期 steer", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    {
      input: fixtureStream([...a2FullFixture()]),
      output: captured.out,
      spawnPi: () => child,
      onResize: () => {},
    },
    rendererOpts(),
  );
  // 运行中（未 settled）：injectUserMessage → steer
  handle.injectUserMessage("fix-early");
  await delay(10);
  assert.ok(child.__stdinWrites.some((w) => w === `${JSON.stringify({ type: "steer", message: "fix-early" })}\n`));
  // 等 fixture 消费完毕（agent_settled 已到）
  await delay(30);
  assert.equal(handle.session.settled, true);
  handle.injectUserMessage("fix-late");
  assert.ok(child.__stdinWrites.some((w) => w === `${JSON.stringify({ type: "prompt", message: "fix-late" })}\n`));
  setTimeout(() => child.__emitExit(0, null), 10);
  assert.equal(await handle.done, 0);
});
test("runRenderer：spawn 抛错 → 明文诊断 + exit 127（frontend#4）", async () => {
  const captured = captureOutput();
  const badSpawn: SpawnPi = () => {
    throw new Error("spawn ENOENT");
  };
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: badSpawn, onResize: () => {} },
    rendererOpts(),
  );
  assert.equal(await handle.done, 127);
  assert.equal(handle.child, null);
  assert.ok(captured.text().includes("❌ pi 启动失败: Error: spawn ENOENT"));
});
test("runRenderer：child error 事件（ENOENT/参数错）→ 诊断 + 127", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts(),
  );
  child.__emitError(new Error("ENOENT"));
  assert.equal(await handle.done, 127);
  assert.ok(captured.text().includes("❌ pi 启动失败: Error: ENOENT"));
});
test("runRenderer：EPIPE/写回调 err 三码收敛为「steer 通道关闭」不崩（spike §E）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild({ failNextWriteWith: "EPIPE" });
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts(),
  );
  await delay(10);
  assert.equal(handle.session.getStatus().steerClosed, true);
  assert.ok(captured.text().includes("⚠ steer 通道关闭"));
  // stdin 异步 error 事件同路径
  const child2 = makeFakeChild();
  const captured2 = captureOutput();
  const h2 = runRenderer(
    { input: null, output: captured2.out, spawnPi: () => child2, onResize: () => {} },
    rendererOpts(),
  );
  child2.__emitStdinError(new Error("ERR_STREAM_DESTROYED"));
  await delay(10);
  assert.equal(h2.session.getStatus().steerClosed, true);
  h2.close();
  child.__emitExit(0, null);
  await handle.done;
});
test("runRenderer：信号死退出码（假 child 128+n）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts(),
  );
  child.__emitExit(null, "SIGTERM");
  assert.equal(await handle.done, 143);
  assert.ok(captured.text().includes("已退出（码 143）"));
});
test("runRenderer：环形缓冲满后增量 flush 不冻结（评审 R#1 回归）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  // 600 个 agent_start（推满 500 环形缓冲）+ 尾部标记行：满后新增，若 flush 冻结则永不显示
  const fixture = [
    ...Array.from({ length: 600 }, () => ev("agent_start")),
    msgStart("user", "FINAL-MARKER"),
  ];
  const handle = runRenderer(
    { input: fixtureStream(fixture), output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts(),
  );
  setTimeout(() => child.__emitExit(0, null), 60);
  assert.equal(await handle.done, 0);
  assert.ok(captured.text().includes("FINAL-MARKER"), "满环形缓冲后新增行仍应 flush 上屏（R#1 冻结回归）");
});
test("runRenderer：首屏行仅绘制一次（评审 R#16 回归）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    { input: fixtureStream([ev("agent_start")]), output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts(),
  );
  setTimeout(() => child.__emitExit(0, null), 30);
  assert.equal(await handle.done, 0);
  const text = captured.text();
  const count = (text.match(/等待首个事件…/g) ?? []).length;
  assert.equal(count, 1, "首屏行应仅绘制一次（R#16 重复绘制回归）");
});
test("runRenderer：injectUserMessage 64K 上限（票 05）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts(),
  );
  const writesBefore = child.__stdinWrites.length; // 初始 prompt 注入后
  handle.injectUserMessage("x".repeat(MAX_STEER_BYTES + 1)); // 超 64K → 拒发
  await delay(10);
  assert.equal(child.__stdinWrites.length, writesBefore, "超长 steer 不写 stdin");
  assert.ok(captured.text().includes("⚠ steer 过长（>64K）未发送"));
  // 正常长度 → steer 写入
  handle.injectUserMessage("ok");
  assert.ok(child.__stdinWrites.some((w) => w === `${JSON.stringify({ type: "steer", message: "ok" })}\n`));
  child.__emitExit(0, null);
  await handle.done;
});
test("runRenderer：injectUserMessage steer 置乐观「已发送」+ 立即刷新（票 06 追加）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts(),
  );
  handle.injectUserMessage("fix-early"); // 未 settled → steer
  assert.equal(handle.session.getStatus().steerSent, true);
  assert.ok(captured.text().includes("⏳ 已发送")); // 立即 paintStatus，不经 500ms 节流
  child.__emitExit(0, null);
  await handle.done;
});
test("runRenderer：appendScroll=false 降级走全量 repaint（backend#15 预案）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  const handle = runRenderer(
    { input: fixtureStream([ev("agent_start")]), output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts({ appendScroll: false }),
  );
  setTimeout(() => child.__emitExit(0, null), 30);
  assert.equal(await handle.done, 0);
  const text = captured.text();
  // 降级路径：flush 走 repaint（重设滚动区 \x1b[2;11r），而非 paintLines 的 \r\n 增量滚动
  const regionResets = (text.match(/\x1b\[2;11r/g) ?? []).length;
  assert.ok(regionResets >= 2, `appendScroll=false 时 flush 应重设滚动区（实得 ${regionResets} 次）`);
});
test("runRenderer：paintStatus 后触发 onBottomRow（票 05 ⚠️② 修正）", async () => {
  const captured = captureOutput();
  const child = makeFakeChild();
  let bottomRows = 0;
  const handle = runRenderer(
    { input: null, output: captured.out, spawnPi: () => child, onResize: () => {} },
    rendererOpts({ onBottomRow: () => bottomRows++ }),
  );
  await delay(20); // tickTimer/statusTimer 驱动 paintStatus → onBottomRow
  assert.ok(bottomRows > 0, "paintStatus 应触发 onBottomRow（输入行重绘）");
  child.__emitExit(0, null);
  await handle.done;
});
