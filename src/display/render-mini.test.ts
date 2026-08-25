// src/display/render-mini.test.ts
// 票 03 B 形态读侧单测（plan §6 用例 13-16）：
//   buildInboxSink 映射 / B 读侧全链（真 Inbox + pollInbox）/ SpawnFields.paneId
//   读回 / resolvePaneId 启动轮询。
// render-core.test.ts 已覆盖 runRenderer 内部 settled→prompt 注入策略，本文件
// 只断言 sink→handle 映射，不重复测其内部逻辑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../task-core/steer.ts";
import { pollInbox } from "../comm/inbox.ts";
import { buildInboxSink, buildPiArgs, initialPromptFor, readSpawnFields, resolvePaneId } from "./render-mini.ts";
import type { RendererHandle } from "./render-core.ts";

// ── fixture 构造助手 ───────────────────────────────────────────────────────

function fakeHandle(): {
  handle: RendererHandle;
  systemLines: string[];
  userMessages: string[];
} {
  const systemLines: string[] = [];
  const userMessages: string[] = [];
  const handle = {
    injectSystemLine: (text: string): void => {
      systemLines.push(text);
    },
    injectUserMessage: (message: string): void => {
      userMessages.push(message);
    },
  };
  return { handle: handle as unknown as RendererHandle, systemLines, userMessages };
}

// ── 13. buildInboxSink（fake RendererHandle） ───────────────────────────────

test("buildInboxSink：steer → injectSystemLine 标签行 + injectUserMessage content；msg notice → 单行上屏零 user", () => {
  const { handle, systemLines, userMessages } = fakeHandle();
  const sink = buildInboxSink(handle);

  sink({
    msgId: "m1",
    type: "steer",
    from: "main",
    to: "pane-1",
    delivery: "directive",
    content: "看这里",
    status: "delivered",
    ts: 1700000000000,
  });

  assert.equal(systemLines.length, 1);
  assert.match(systemLines[0] ?? "", /来自 main/);
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0], "看这里");

  // msg notice（票 04）：单行系统行，不触发 user 注入
  sink({
    msgId: "m2",
    type: "msg",
    from: "main",
    to: "pane-1",
    delivery: "notice",
    content: "notice",
    status: "delivered",
    ts: 1700000000001,
  });
  assert.equal(systemLines.length, 2);
  assert.match(systemLines[1] ?? "", /来自 main: notice/);
  assert.equal(userMessages.length, 1);
});

// ── 14. B 读侧全链（真 Inbox + tmp + fake handle） ──────────────────────────

test("B 读侧全链：deliver → pollInbox → sink 映射 + 落盘 status 推进到 read", async () => {
  const root = await mkdtemp(join(tmpdir(), "rm-inbox-"));
  const { handle, systemLines, userMessages } = fakeHandle();

  const m = await new Inbox(root).deliver({
    type: "steer",
    from: "main",
    to: "42",
    delivery: "directive",
    content: "turn-now",
  });

  const result = await pollInbox(root, "42", buildInboxSink(handle));

  assert.equal(result.delivered.length, 1);
  assert.equal(systemLines.length, 1);
  assert.match(systemLines[0] ?? "", /来自 main/);
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0], "turn-now");

  // 落盘推进到 read
  const onDisk = JSON.parse(
    await readFile(join(root, "inbox", "42", `${m.msgId}.json`), "utf8"),
  ) as { status: string };
  assert.equal(onDisk.status, "read");
});

// ── 15. SpawnFields.paneId 读回 ─────────────────────────────────────────────

test("readSpawnFields：payload.spawn.paneId 读回（缺失省略键，兼容既有三字段 deepEqual）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-pane-"));
  const withPane = join(dir, "with.json");
  writeFileSync(
    withPane,
    JSON.stringify({ taskId: "t", startedAt: 12345, payload: { spawn: { prompt: "hi", role: "R", paneId: "42" } } }),
  );
  assert.equal(readSpawnFields(withPane).paneId, "42");
  // 其余字段不受影响
  assert.equal(readSpawnFields(withPane).prompt, "hi");

  const noPane = join(dir, "no-pane.json");
  writeFileSync(noPane, JSON.stringify({ taskId: "t", payload: { spawn: { prompt: "hi" } } }));
  assert.equal(readSpawnFields(noPane).paneId, undefined);

  const emptyPane = join(dir, "empty-pane.json");
  writeFileSync(emptyPane, JSON.stringify({ taskId: "t", payload: { spawn: { prompt: "hi", paneId: "" } } }));
  assert.equal(readSpawnFields(emptyPane).paneId, undefined);

  rmSync(dir, { recursive: true, force: true });
});

// ── 16. resolvePaneId ───────────────────────────────────────────────────────

test("resolvePaneId：文件 paneId 空→非空 轮询解析成功", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-resolve-"));
  const p = join(dir, "t.json");
  writeFileSync(p, JSON.stringify({ payload: { spawn: { paneId: "" } } }));

  // 测试中途重写文件：先空、20ms 后写回 paneId
  const rewrite = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(p, JSON.stringify({ payload: { spawn: { paneId: "42" } } }));
  })();

  const paneId = await resolvePaneId(p, { pollMs: 5, timeoutMs: 2000 });
  await rewrite;
  assert.equal(paneId, "42");
  rmSync(dir, { recursive: true, force: true });
});

test("resolvePaneId：恒空超时返回 \"\"", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-resolve2-"));
  const p = join(dir, "t.json");
  writeFileSync(p, JSON.stringify({ payload: { spawn: { paneId: "" } } }));

  const paneId = await resolvePaneId(p, { pollMs: 5, timeoutMs: 50 });
  assert.equal(paneId, "");
  rmSync(dir, { recursive: true, force: true });
});

// ── 票 TD2：AbortSignal 提前退出（耗时上界） ────────────────────────────

test("resolvePaneId：signal abort 提前退出（elapsed < 1000ms，不空转至 30s 超时）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-abort-"));
  const p = join(dir, "t.json");
  writeFileSync(p, JSON.stringify({ payload: { spawn: { paneId: "" } } }));

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const start = Date.now();
  const paneId = await resolvePaneId(p, { signal: ac.signal, pollMs: 20, timeoutMs: 30_000 });
  const elapsed = Date.now() - start;
  assert.equal(paneId, "");
  assert.ok(elapsed < 1000, `abort 应提前退出，实际耗时 ${elapsed}ms`);
  rmSync(dir, { recursive: true, force: true });
});

// ── 票 04/08：msg 分支 + resumeFrom（用例 19-23） ─────────────────────────

test("buildInboxSink：msg notice → injectSystemLine「📨 来自 X: content」+ injectUserMessage 零调用", () => {
  const { handle, systemLines, userMessages } = fakeHandle();
  const sink = buildInboxSink(handle);

  sink({
    msgId: "m1",
    type: "msg",
    from: "main",
    to: "pane-1",
    delivery: "notice",
    content: "看这里\n第二行",
    status: "delivered",
    ts: 1700000000000,
  });

  assert.equal(systemLines.length, 1);
  assert.match(systemLines[0] ?? "", /来自 main/);
  assert.ok((systemLines[0] ?? "").includes("看这里 第二行")); // 换行压空格防破行
  assert.equal(userMessages.length, 0);
});

test("buildInboxSink：msg directive → injectSystemLine 标签（含时间戳）+ injectUserMessage content", () => {
  const { handle, systemLines, userMessages } = fakeHandle();
  const sink = buildInboxSink(handle);

  sink({
    msgId: "m1",
    type: "msg",
    from: "main",
    to: "pane-1",
    delivery: "directive",
    content: "go-now",
    status: "delivered",
    ts: 1700000000000,
  });

  assert.equal(systemLines.length, 1);
  assert.match(systemLines[0] ?? "", /来自 main/);
  assert.match(systemLines[0] ?? "", /\d{2}:\d{2}:\d{2}/);
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0], "go-now");
});

test("buildInboxSink：from 带 ANSI 色码 → 标签行剥转义序列残留，仅剩明文", () => {
  const { handle, systemLines } = fakeHandle();
  const sink = buildInboxSink(handle);

  sink({
    msgId: "m1",
    type: "steer",
    from: "\x1b[31mred\x1b[0m",
    to: "pane-1",
    delivery: "directive",
    content: "看这里",
    status: "delivered",
    ts: 1700000000000,
  });

  assert.equal(systemLines.length, 1);
  assert.match(systemLines[0] ?? "", /来自 red/);
  assert.doesNotMatch(systemLines[0] ?? "", /\x1b/); // 无转义序列残留
});

test("readSpawnFields：resumeFrom 非空读回 / 缺失省略键（兼容既有 deepEqual）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-resume-"));
  const withResume = join(dir, "with.json");
  writeFileSync(
    withResume,
    JSON.stringify({ taskId: "t", payload: { spawn: { prompt: "hi", role: "R", resumeFrom: "sess-1" } } }),
  );
  assert.equal(readSpawnFields(withResume).resumeFrom, "sess-1");

  const noResume = join(dir, "no.json");
  writeFileSync(noResume, JSON.stringify({ taskId: "t", payload: { spawn: { prompt: "hi" } } }));
  assert.equal(readSpawnFields(noResume).resumeFrom, undefined);

  const emptyResume = join(dir, "empty.json");
  writeFileSync(emptyResume, JSON.stringify({ taskId: "t", payload: { spawn: { prompt: "hi", resumeFrom: "" } } }));
  assert.equal(readSpawnFields(emptyResume).resumeFrom, undefined);

  rmSync(dir, { recursive: true, force: true });
});

test("buildPiArgs：resumeFrom 非空 → --session <id>、无 --append-system-prompt/--name；缺省 → 与现状一致", () => {
  assert.deepEqual(
    buildPiArgs({ sessionDir: "/s", role: "worker", personaFile: "/p.md", personaExists: true, resumeFrom: "sess-9" }),
    ["-p", "--mode", "rpc", "--session-dir", "/s", "--session", "sess-9", "--approve"],
  );
  // 缺省 resumeFrom → 与既有 render-core.test.ts 三组 deepEqual 逐字节一致（回归锚点）
  assert.deepEqual(buildPiArgs({ sessionDir: "/tmp/s", role: "", personaFile: "", personaExists: false }), [
    "-p",
    "--mode",
    "rpc",
    "--session-dir",
    "/tmp/s",
    "--approve",
  ]);
  assert.deepEqual(buildPiArgs({ sessionDir: "/s", role: "worker", personaFile: "/p.md", personaExists: true }), [
    "-p",
    "--mode",
    "rpc",
    "--session-dir",
    "/s",
    "--append-system-prompt",
    "/p.md",
    "--name",
    "worker",
    "--approve",
  ]);
});

test("initialPromptFor：resumeFrom 非空 → \"\"；空/undefined → 原 prompt", () => {
  assert.equal(initialPromptFor("sess-1", "原任务"), "");
  assert.equal(initialPromptFor("", "原任务"), "原任务");
  assert.equal(initialPromptFor(undefined, "原任务"), "原任务");
});
