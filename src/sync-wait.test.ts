// src/sync-wait.test.ts — sync-wait.ts 单测（fake store + timer 注入，不依赖真实农场）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWaiter, isTerminalStatus, TERMINAL_STATUSES, extractSummaryFromJsonl, sha256Of } from "./sync-wait.ts";
import { TaskStore } from "./task-core/store.ts";
import type { TaskRecord } from "./task-core/store.ts";

function makeRecord(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "abc123",
    type: "spawn",
    parentId: null,
    depth: 1,
    status: "running",
    owner: "p1+1",
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: 1000,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs: 600,
    attempts: 0,
    maxAttempts: 2,
    backoffSecs: [5, 30],
    payload: {
      spawn: { role: "worker", prompt: "p", cwd: "/tmp", resumeFrom: null, paneId: "1", form: "worker" },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: [], delivery: "notice", content: "" },
      schedule: { mode: "once", cron: "", intervalSecs: 0, onceAt: 0, lastRun: 0, nextRun: 0, firedTaskIds: [] },
    },
    result: { sessionDir: "", exitCode: null, cost: { model: "", inputTokens: 0, outputTokens: 0 } },
    ...over,
  };
}

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sync-wait-"));
  return dir;
}

test("extractSummaryFromJsonl：锚定最后一条 assistant text，忽略 delta/其他角色（评审 R2）", () => {
  const jsonl = [
    // message_update delta 残片（不取）
    JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "delta part" }] } }),
    // 中间 assistant（含工具调用无 text）
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "toolCall", name: "bash" }] } }),
    // user 消息（不取）
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "question" }] } }),
    // 最后 assistant 权威全文（取）
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "y" }, { type: "text", text: "最终答案 ABC" }] } }),
    "",
  ].join("\n");
  assert.equal(extractSummaryFromJsonl(jsonl), "最终答案 ABC");
});

test("extractSummaryFromJsonl：>8KB 截断", () => {
  const long = "x".repeat(10_000);
  const jsonl = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: long }] } });
  const out = extractSummaryFromJsonl(jsonl);
  assert.equal(out.length, 8192);
});

test("sha256Of：确定性", () => {
  const a = sha256Of("hello");
  const b = sha256Of("hello");
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(a, sha256Of("world"));
});

test("wait：.result sha256 对拍不一致 → 回退 jsonl 原文并标注 jsonl-fallback（评审 R2）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  await store.writeTask(makeRecord({ status: "done", result: { sessionDir: "/s/6", exitCode: 0, cost: { model: "m", inputTokens: 1, outputTokens: 2 } } }));
  // 构造 session jsonl（权威答案）
  const sessDir = join(root, "sessions", "abc123");
  await mkdir(sessDir, { recursive: true });
  const raw = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "真答案" }] } });
  await writeFile(join(sessDir, "2026-01-01T00-00-00-000Z_x.jsonl"), raw, "utf8");
  // .result 的 summary 与 sha256 不匹配（sha 是旧 jsonl 的）
  await mkdir(join(root, "status"), { recursive: true });
  await writeFile(
    join(root, "status", "abc123.result"),
    JSON.stringify({ exitCode: 0, sessionDir: sessDir, summary: "旧答案", sha256: sha256Of("old-content"), writtenAt: Date.now() }),
    "utf8",
  );
  const waiter = createWaiter({ store, farmRoot: root });
  const out = await waiter.wait("abc123", { timeoutMs: 1000 });
  assert.equal(out.resultSource, "jsonl-fallback");
  assert.equal(out.result, "真答案");
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("isTerminalStatus：与 farm.ts 终态集合同口径（done/aborted/failed/cancelled 终态，timeout 非终态）", () => {
  for (const s of ["done", "aborted", "failed", "cancelled"]) {
    assert.equal(isTerminalStatus(s as never), true, `${s} 应为终态`);
  }
  for (const s of ["queued", "running", "timeout"]) {
    assert.equal(isTerminalStatus(s as never), false, `${s} 不应为终态`);
  }
  assert.equal(TERMINAL_STATUSES.size, 4);
});

test("wait：任务已终态（done）→ 立即返回完整结果（不进入等待）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  const rec = makeRecord({ status: "done", result: { sessionDir: "/s/1", exitCode: 0, cost: { model: "m", inputTokens: 1, outputTokens: 2 } } });
  await store.writeTask(rec);
  const waiter = createWaiter({ store, farmRoot: root });
  const out = await waiter.wait("abc123", { timeoutMs: 1000 });
  assert.equal(out.status, "done");
  assert.equal(out.exitCode, 0);
  assert.equal(out.unfinished, false);
  assert.equal(out.cost.model, "m");
  assert.equal(out.waitedMs, 0);
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("wait：任务缺失（未入队/已 GC）→ 返回失败而非死等（评审 R6）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  const waiter = createWaiter({ store, farmRoot: root });
  const out = await waiter.wait("nope", { timeoutMs: 300 });
  assert.equal(out.status, "failed");
  assert.equal(out.missing, true);
  assert.equal(out.unfinished, true);
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("wait：运行中任务 + 事件钩子（registerDone）→ 低延迟 resolve（事件主通道）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  await store.writeTask(makeRecord({ status: "running" }));
  const waiter = createWaiter({ store, farmRoot: root, });
  // 轮询间隔拉长，证明 resolve 来自事件钩子而非轮询
  const p = waiter.wait("abc123", { timeoutMs: 5000, pollIntervalMs: 10_000 });
  // 任务完成：写 done 信号 + 事件钩子
  await store.writeTask(makeRecord({ status: "done", result: { sessionDir: "/s/2", exitCode: 0, cost: { model: "m", inputTokens: 3, outputTokens: 4 } } }));
  await mkdir(join(root, "status"), { recursive: true });
  await writeFile(join(root, "status", "abc123.done"), JSON.stringify({ exitCode: 0, sessionDir: "/s/2" }), "utf8");
  waiter.registerDone("abc123");
  const out = await p;
  assert.equal(out.status, "done");
  assert.equal(out.unfinished, false);
  assert.equal(waiter.isWaiting("abc123"), false);
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("wait：事件丢失 → 轮询兜底仍能拿到结果（评审 R6 终态面全覆盖）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  await store.writeTask(makeRecord({ status: "running" }));
  const waiter = createWaiter({ store, farmRoot: root });
  const p = waiter.wait("abc123", { timeoutMs: 5000, pollIntervalMs: 50 });
  // 不触发 registerDone：只靠轮询
  await store.writeTask(makeRecord({ status: "done", result: { sessionDir: "/s/3", exitCode: 0, cost: { model: "m", inputTokens: 5, outputTokens: 6 } } }));
  const out = await p;
  assert.equal(out.status, "done");
  assert.equal(out.unfinished, false);
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("wait：超时 → 返回 UNFINISHED 快照（timeout:true），不抛异常、任务继续", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  await store.writeTask(makeRecord({ status: "running" }));
  const waiter = createWaiter({ store, farmRoot: root });
  const out = await waiter.wait("abc123", { timeoutMs: 150, pollIntervalMs: 50 });
  assert.equal(out.unfinished, true);
  assert.equal(out.timeout, true);
  assert.equal(out.status, "timeout");
  // 任务未被杀：record 仍 running
  const rec = await store.readTask("abc123");
  assert.equal(rec?.status, "running");
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("wait：abort signal → 快速返回未完成快照（timeout:false），任务不杀", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  await store.writeTask(makeRecord({ status: "running" }));
  const waiter = createWaiter({ store, farmRoot: root });
  const ac = new AbortController();
  const p = waiter.wait("abc123", { timeoutMs: 5000, signal: ac.signal, pollIntervalMs: 50 });
  setTimeout(() => ac.abort(), 60);
  const out = await p;
  assert.equal(out.unfinished, true);
  assert.equal(out.timeout, false);
  const rec = await store.readTask("abc123");
  assert.equal(rec?.status, "running");
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("wait：心跳 onProgress 节流到达（评审 R1 阻塞 UX 对策）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  await store.writeTask(makeRecord({ status: "running" }));
  const waiter = createWaiter({ store, farmRoot: root });
  const heartbeats: string[] = [];
  const p = waiter.wait("abc123", { timeoutMs: 300, pollIntervalMs: 40, heartbeatIntervalMs: 80, onProgress: (m) => heartbeats.push(m) });
  await p;
  assert.ok(heartbeats.length >= 1, `应至少 1 次心跳，实际 ${heartbeats.length}`);
  assert.match(heartbeats[0], /仍在等待/);
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("wait：.result 文件命中 → done + summary（评审 R10 信号面）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  // record 仍 running（状态迁移滞后），但 .result 已写 → done
  await store.writeTask(makeRecord({ status: "running" }));
  await mkdir(join(root, "status"), { recursive: true });
  await writeFile(
    join(root, "status", "abc123.result"),
    JSON.stringify({ exitCode: 0, sessionDir: "/s/4", summary: "final answer", sha256: "x", writtenAt: Date.now() }),
    "utf8",
  );
  const waiter = createWaiter({ store, farmRoot: root });
  const out = await waiter.wait("abc123", { timeoutMs: 1000 });
  assert.equal(out.status, "done");
  assert.equal(out.result, "final answer");
  assert.equal(out.resultSource, ".result");
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("wait：cost 回退读 usage sidecar（评审 R11）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  await store.writeTask(makeRecord({ status: "done", result: { sessionDir: "/s/5", exitCode: 0, cost: { model: "", inputTokens: 0, outputTokens: 0 } } }));
  await mkdir(join(root, "usage"), { recursive: true });
  await writeFile(join(root, "usage", "abc123.json"), JSON.stringify({ model: "m2", inputTokens: 10, outputTokens: 20, updatedAt: Date.now() }), "utf8");
  const waiter = createWaiter({ store, farmRoot: root });
  const out = await waiter.wait("abc123", { timeoutMs: 1000 });
  assert.equal(out.cost.model, "m2");
  assert.equal(out.cost.inputTokens, 10);
  assert.equal(out.cost.outputTokens, 20);
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("isWaiting：wait 开始即注册，覆盖整个等待窗口（评审 R1①）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  await store.writeTask(makeRecord({ status: "running" }));
  const waiter = createWaiter({ store, farmRoot: root });
  const p = waiter.wait("abc123", { timeoutMs: 300, pollIntervalMs: 50 });
  assert.equal(waiter.isWaiting("abc123"), true, "wait 开始后应立即注册");
  await p;
  assert.equal(waiter.isWaiting("abc123"), false, "结束后应注销");
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("cancel：abort 清理删条目（评审 R7）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  await store.writeTask(makeRecord({ status: "running" }));
  const waiter = createWaiter({ store, farmRoot: root });
  const p = waiter.wait("abc123", { timeoutMs: 5000, pollIntervalMs: 50 });
  const out = await waiter.cancel("abc123");
  assert.ok(out !== null);
  assert.equal(out!.unfinished, true);
  const r = await p;
  assert.equal(r.unfinished, true);
  assert.equal(waiter.isWaiting("abc123"), false);
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("wait：并发 N=3 共享轮询 ticker（单 ticker 驱动，非每 waiter 一 timer，评审 R6 轮询风暴对策）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  for (const id of ["aaa", "bbb", "ccc"]) {
    await store.writeTask(makeRecord({ taskId: id, status: "running" }));
  }
  const waiter = createWaiter({ store, farmRoot: root });
  // 三个并发 wait，轮询间隔 40ms；事件丢失（不 registerDone）→ 只靠共享轮询兜底
  const ps = ["aaa", "bbb", "ccc"].map((id) => waiter.wait(id, { timeoutMs: 3000, pollIntervalMs: 40 }));
  // 逐步完成三个任务
  await store.writeTask(makeRecord({ taskId: "aaa", status: "done", result: { sessionDir: "/s/a", exitCode: 0, cost: { model: "m", inputTokens: 1, outputTokens: 1 } } }));
  await store.writeTask(makeRecord({ taskId: "bbb", status: "done", result: { sessionDir: "/s/b", exitCode: 0, cost: { model: "m", inputTokens: 1, outputTokens: 1 } } }));
  await store.writeTask(makeRecord({ taskId: "ccc", status: "done", result: { sessionDir: "/s/c", exitCode: 0, cost: { model: "m", inputTokens: 1, outputTokens: 1 } } }));
  const outs = await Promise.all(ps);
  assert.equal(outs.filter((o) => o.status === "done" && !o.unfinished).length, 3, "三个 wait 全部通过共享轮询拿到结果");
  waiter.shutdown();
  await rm(root, { recursive: true, force: true });
});

test("shutdown：停 ticker + 全部 resolve 未完成快照（评审 R7）", async () => {
  const root = await tmpRoot();
  const store = new TaskStore(root);
  await store.writeTask(makeRecord({ status: "running" }));
  const waiter = createWaiter({ store, farmRoot: root });
  const p = waiter.wait("abc123", { timeoutMs: 5000, pollIntervalMs: 50 });
  waiter.shutdown();
  const out = await p;
  assert.equal(out.unfinished, true);
  assert.equal(waiter.isWaiting("abc123"), false);
  await rm(root, { recursive: true, force: true });
});
