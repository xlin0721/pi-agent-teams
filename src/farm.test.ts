// src/farm.test.ts
// 只断言外部行为（纯函数部分 + 装配路径部分）：
//   聚合器 aggregateEvents（2s 窗口/多事件/空事件/跨窗口续发/去重）、
//   补发过滤 filterReplay（owner/终态/notifiedAt/24h 边界/缺字段容错/排序）、
//   探测差集 diffPanes + diffGoneRunning（差集/空集/gone 存活判定）、
//   通知形状 buildDoneEvent/buildDoneText（摘要 + 恢复命令行）、
//   wireFarm 装配路径（真 TaskStore + 真子进程 pid + 假 display/pi/notify，
//   session_start 跨重启补发 US21 / shutdown×in-flight spawn 竞态 /
//   shutdown 杀 timeout pane / 死 owner running 僵尸回收）。
// 纯函数部分零 I/O、零定时器、零 pi SDK import；装配路径部分用临时目录 +
// t.after 清理，不碰真实 wezterm cli。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLUSH_WINDOW_MS,
  REPLAY_WINDOW_MS,
  aggregateEvents,
  buildDoneEvent,
  buildDoneText,
  diffGoneRunning,
  diffPanes,
  filterReplay,
  gcOnce,
  isPidAlive,
  isTerminalStatus,
  ownerProcessDead,
  parseOwnerPid,
  wireFarm,
} from "./farm.ts";
import type { DisplayClient, FarmDoneEvent, FarmDoneMessage, FarmPi, TerminalStatus } from "./farm.ts";
import type { TaskStatus } from "./task-core/states.ts";
import type { TaskRecord } from "./task-core/store.ts";
import { TaskStore } from "./task-core/store.ts";
import { Queue } from "./task-core/queue.ts";
import type { Executor, StepReport } from "./task-core/queue.ts";

/** task record fixture（全字段；测试按需覆写/后改嵌套字段） */
function taskRecord(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  const t0 = 1_000_000;
  return {
    type: "spawn",
    parentId: null,
    depth: 0,
    status: overrides.status ?? "done",
    owner: "pid-100",
    createdAt: t0,
    updatedAt: t0,
    startedAt: t0,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs: 600,
    attempts: 1,
    maxAttempts: 2,
    backoffSecs: [5, 30],
    payload: {
      spawn: { form: "tui", role: "explorer", prompt: "", cwd: "", resumeFrom: null, paneId: "" },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: [], delivery: "notice", content: "" },
      schedule: { mode: "once", cron: "", intervalSecs: 0, onceAt: 0, lastRun: 0, nextRun: 0, firedTaskIds: [] },
    },
    result: { sessionDir: "", exitCode: null, cost: { model: "", inputTokens: 0, outputTokens: 0 } },
    ...overrides,
  };
}

/** 通知事件 fixture */
function event(taskId: string, status: TerminalStatus = "done"): FarmDoneEvent {
  return { taskId, role: "explorer", status, durationMs: 1000, exitCode: 0 };
}

/** running + paneId 的探测 fixture（task→paneId 从 task record 取） */
function runningTask(taskId: string, paneId: string): TaskRecord {
  const t = taskRecord({ taskId, status: "running" });
  t.payload.spawn.paneId = paneId;
  return t;
}

// ---------- aggregateEvents：通知聚合器 ----------

test("aggregateEvents：距上次 flush ≥2s 发 1 条，<2s hold（2s 窗口）", () => {
  const e = event("a1");
  const flush = aggregateEvents([e], 1000, 1000 + FLUSH_WINDOW_MS);
  assert.deepEqual(flush, { pending: [e], nextFlushAt: 1000 + FLUSH_WINDOW_MS });
  const hold = aggregateEvents([e], 1000, 1000 + FLUSH_WINDOW_MS - 1);
  assert.deepEqual(hold, { pending: [], nextFlushAt: 1000 });
});

test("aggregateEvents：多事件窗口到期一次 flush 全部（1 条 followUp 携带多事件）", () => {
  const events = [event("a1"), event("a2"), event("a3")];
  const r = aggregateEvents(events, 0, 5000);
  assert.equal(r.pending.length, 3);
  assert.deepEqual(r.pending, events);
  assert.equal(r.nextFlushAt, 5000);
});

test("aggregateEvents：空事件原样返回（nextFlushAt 不变）", () => {
  assert.deepEqual(aggregateEvents([], 4242, 999_999), { pending: [], nextFlushAt: 4242 });
});

test("aggregateEvents：跨窗口续发（hold 事件保留、到期齐发、新窗口重计时）", () => {
  const e1 = event("a1");
  const hold = aggregateEvents([e1], 0, 1000);
  assert.deepEqual(hold, { pending: [], nextFlushAt: 0 });
  const e2 = event("a2");
  const flush = aggregateEvents([e1, e2], 0, 2100);
  assert.deepEqual(flush.pending, [e1, e2]);
  assert.equal(flush.nextFlushAt, 2100);
  const e3 = event("a3");
  const hold2 = aggregateEvents([e3], 2100, 2500);
  assert.deepEqual(hold2, { pending: [], nextFlushAt: 2100 });
  const flush2 = aggregateEvents([e3], 2100, 4100);
  assert.deepEqual(flush2.pending, [e3]);
  assert.equal(flush2.nextFlushAt, 4100);
});

test("aggregateEvents：lastFlushAt=0 初始态（epoch ms 时钟下首条事件立即发，无需空等 2s）", () => {
  const r = aggregateEvents([event("a1")], 0, 5000);
  assert.deepEqual(r.pending.map((e) => e.taskId), ["a1"]);
  assert.equal(r.nextFlushAt, 5000);
  // 边界一致性：now < FLUSH_WINDOW_MS 且从未 flush 过 → hold
  assert.deepEqual(aggregateEvents([event("a1")], 0, FLUSH_WINDOW_MS - 1).pending, []);
});

test("aggregateEvents：同 taskId 重复事件去重（防同任务双决策重复通知）", () => {
  const e1 = event("a1");
  const e2 = event("a1");
  assert.deepEqual(aggregateEvents([e1, e2], 0, 5000).pending, [e1]);
});

test("aggregateEvents：now 非有限数抛 TypeError", () => {
  assert.throws(() => aggregateEvents([event("a1")], 0, Number.NaN), TypeError);
  assert.throws(() => aggregateEvents("x" as unknown as FarmDoneEvent[], 0, 100), TypeError);
});

// ---------- filterReplay：补发过滤 ----------

test("filterReplay：owner==本进程 才入选（防双会话重复通知）", () => {
  const mine = taskRecord({ taskId: "m1", owner: "me", updatedAt: 2000 });
  const other = taskRecord({ taskId: "o1", owner: "other", updatedAt: 2000 });
  const legacy = taskRecord({ taskId: "l1", updatedAt: 2000 });
  delete (legacy as { owner?: string }).owner; // 存量缺 owner → 只读外务，不补发
  const out = filterReplay([mine, other, legacy], "me", 10_000);
  assert.deepEqual(out.map((t) => t.taskId), ["m1"]);
});

test("filterReplay：仅终态入选（done/aborted/failed/cancelled；timeout 可复活不入选）", () => {
  const statuses: TaskStatus[] = ["done", "aborted", "failed", "cancelled", "queued", "running", "timeout"];
  const tasks = statuses.map((status, i) => taskRecord({ taskId: `t${i}`, status, updatedAt: 5000 }));
  const out = filterReplay(tasks, "pid-100", 10_000);
  assert.deepEqual(out.map((t) => t.status), ["done", "aborted", "failed", "cancelled"]);
});

test("filterReplay：notifiedAt 已通知排除；缺/0 入选", () => {
  const notified = taskRecord({ taskId: "n1", notifiedAt: 123, updatedAt: 5000 });
  const zero = taskRecord({ taskId: "z1", notifiedAt: 0, updatedAt: 5000 });
  const missing = taskRecord({ taskId: "x1", updatedAt: 5000 });
  delete (missing as { notifiedAt?: number }).notifiedAt;
  const out = filterReplay([notified, zero, missing], "pid-100", 10_000);
  // updatedAt 相同 → taskId 升序破序
  assert.deepEqual(out.map((t) => t.taskId), ["x1", "z1"]);
});

test("filterReplay：updatedAt≤24h 边界（24h 整入选、超 1ms 排除、未来时间排除）", () => {
  const now = 100_000_000;
  const edge = taskRecord({ taskId: "e1", updatedAt: now - REPLAY_WINDOW_MS });
  const over = taskRecord({ taskId: "o1", updatedAt: now - REPLAY_WINDOW_MS - 1 });
  const future = taskRecord({ taskId: "f1", updatedAt: now + 1 });
  const out = filterReplay([edge, over, future], "pid-100", now);
  assert.deepEqual(out.map((t) => t.taskId), ["e1"]);
});

test("filterReplay：缺字段容错不抛（owner/notifiedAt/updatedAt 缺失）", () => {
  const noUpdated = taskRecord({ taskId: "u1" });
  delete (noUpdated as { updatedAt?: number }).updatedAt; // 无法证明 24h 内 → 排除
  const noNotified = taskRecord({ taskId: "n1", updatedAt: 5000 });
  delete (noNotified as { notifiedAt?: number }).notifiedAt; // 视作未通知 → 入选
  const noOwner = taskRecord({ taskId: "o1", updatedAt: 5000 });
  delete (noOwner as { owner?: string }).owner; // 只读外务 → 排除
  const out = filterReplay([noUpdated, noNotified, noOwner], "pid-100", 10_000);
  assert.deepEqual(out.map((t) => t.taskId), ["n1"]);
});

test("filterReplay：按 updatedAt 升序返回（补发顺序确定性）", () => {
  const late = taskRecord({ taskId: "late", updatedAt: 9000 });
  const early = taskRecord({ taskId: "early", updatedAt: 1000 });
  const out = filterReplay([late, early], "pid-100", 10_000);
  assert.deepEqual(out.map((t) => t.taskId), ["early", "late"]);
});

test("filterReplay：owner 空串/非字符串 → 空列表", () => {
  const t = taskRecord({ taskId: "a1", updatedAt: 5000 });
  assert.deepEqual(filterReplay([t], "", 10_000), []);
  assert.deepEqual(filterReplay([t], null as unknown as string, 10_000), []);
  assert.throws(() => filterReplay([t], "me", Number.NaN), TypeError);
});

// ---------- filterReplay：跨重启补发（pidAlive 注入，确定性） ----------
// owner 落盘格式 = "pid+启动时间"（PRD §13.3）。以下用固定字符串，pidAlive 注入替代
// 真实 process.kill 探测，保证不依赖本机进程表。

/** 探测探测记录器：断言谁被探测、返回预设结果 */
function probe(dead: (pid: number) => boolean): { fn: (pid: number) => boolean; calls: number[] } {
  const calls: number[] = [];
  return { calls, fn: (pid) => (calls.push(pid), dead(pid)) };
}

test("filterReplay：旧 owner pid 已死（pidAlive=false）→ 补发（跨重启，quit 后新 pid 接管）", () => {
  const old = taskRecord({ taskId: "r1", owner: "12345+1700000000000", updatedAt: 5000 });
  const me = "20000+1700000100000";
  const p = probe(() => false);
  const out = filterReplay([old], me, 10_000, p.fn);
  assert.deepEqual(out.map((t) => t.taskId), ["r1"]);
  assert.deepEqual(p.calls, [12345]); // 只探测旧 owner 的 pid
});

test("filterReplay：owner 进程仍活（pidAlive=true）→ 不补发（防双会话重复通知）", () => {
  const alive = taskRecord({ taskId: "a1", owner: "12345+1700000000000", updatedAt: 5000 });
  const me = "20000+1700000100000";
  const p = probe(() => true);
  const out = filterReplay([alive], me, 10_000, p.fn);
  assert.deepEqual(out, []);
  assert.deepEqual(p.calls, [12345]);
});

test("filterReplay：allowDeadOwner=false → 死 owner 任务不补发（mini-farm 只补发本进程）", () => {
  const me = "20000+1700000100000";
  const mine = taskRecord({ taskId: "m1", owner: me, updatedAt: 5000 });
  const old = taskRecord({ taskId: "r1", owner: "12345+1700000000000", updatedAt: 5000 });
  // false：死 owner 任务排除，且不探测（boom 抛错即证）
  const boom = () => {
    throw new Error("allowDeadOwner=false 不应探测死 owner");
  };
  const outFalse = filterReplay([old, mine], me, 10_000, boom, false);
  assert.deepEqual(outFalse.map((t) => t.taskId), ["m1"]);
  // true（默认）：死 owner 任务仍补发（跨重启语义不回归）
  const p = probe(() => false);
  const outTrue = filterReplay([old, mine], me, 10_000, p.fn);
  assert.deepEqual(outTrue.map((t) => t.taskId), ["m1", "r1"]);
});

test("filterReplay：owner==本进程 无论 pidAlive 结果 → 补发（且不探测本进程）", () => {
  const me = "20000+1700000100000";
  const mine = taskRecord({ taskId: "m1", owner: me, updatedAt: 5000 });
  const boom = () => {
    throw new Error("owner==本进程 不应触发存活探测");
  };
  const outDead = filterReplay([mine], me, 10_000, () => false);
  const outAlive = filterReplay([mine], me, 10_000, () => true);
  const outThrow = filterReplay([mine], me, 10_000, boom);
  assert.deepEqual(outDead.map((t) => t.taskId), ["m1"]);
  assert.deepEqual(outAlive.map((t) => t.taskId), ["m1"]);
  assert.deepEqual(outThrow.map((t) => t.taskId), ["m1"]);
});

test("filterReplay：缺 owner / 非 pid+启动时间格式 → 不补发（保守视为活，且不探测）", () => {
  const noOwner = taskRecord({ taskId: "n1", updatedAt: 5000 });
  delete (noOwner as { owner?: string }).owner;
  const legacy = taskRecord({ taskId: "l1", owner: "legacy-owner", updatedAt: 5000 });
  const badPid = taskRecord({ taskId: "b1", owner: "abc+1700000000000", updatedAt: 5000 });
  const noStart = taskRecord({ taskId: "s1", owner: "12345+", updatedAt: 5000 });
  const boom = () => {
    throw new Error("pid 不可解析 不应触发存活探测");
  };
  const out = filterReplay([noOwner, legacy, badPid, noStart], "20000+1700000100000", 10_000, boom);
  assert.deepEqual(out, []);
});

// ---------- ownerProcessDead / parseOwnerPid：归属判定边界 ----------

test("ownerProcessDead：pid 可解析且探测死（pidAlive=false）→ true；活/不可解析 → false", () => {
  const owner = "12345+1700000000000";
  assert.equal(ownerProcessDead(owner, () => false), true);
  assert.equal(ownerProcessDead(owner, () => true), false);
  // 不可解析 → 保守视为活（false），且不调用 pidAlive
  const boom = () => {
    throw new Error("pid 不可解析 不应调用 pidAlive");
  };
  assert.equal(ownerProcessDead("", boom), false);
  assert.equal(ownerProcessDead(null, boom), false);
  assert.equal(ownerProcessDead(undefined, boom), false);
  assert.equal(ownerProcessDead("garbage", boom), false);
});

test("parseOwnerPid：pid+启动时间 → pid；空串/非字符串/格式异常 → null", () => {
  assert.equal(parseOwnerPid("12345+1700000000000"), 12345);
  assert.equal(parseOwnerPid("+1700000000000"), null); // 空 pid 部分
  assert.equal(parseOwnerPid("12345+"), null); // 空启动时间部分
  assert.equal(parseOwnerPid("12345"), null); // 无 +
  assert.equal(parseOwnerPid(""), null);
  assert.equal(parseOwnerPid(null), null);
  assert.equal(parseOwnerPid(undefined), null);
  assert.equal(parseOwnerPid(12345), null); // 非字符串
  assert.equal(parseOwnerPid("12a+1700000000000"), null); // pid 非纯数字
  assert.equal(parseOwnerPid("0+1700000000000"), null); // pid < 1
  assert.equal(parseOwnerPid("999999999999999999999+1700000000000"), null); // 非安全整数
});

// ---------- diffPanes / diffGoneRunning：探测差集 ----------

test("diffPanes：差集 = 期望有实际无（gone 列表）", () => {
  assert.deepEqual(diffPanes(["1", "2", "3"], ["1", "3"]), ["2"]);
});

test("diffPanes：空差集 → []", () => {
  assert.deepEqual(diffPanes(["1", "2"], ["1", "2", "3"]), []);
});

test("diffPanes：期望侧重复/空串忽略（保序去重）", () => {
  assert.deepEqual(diffPanes(["1", "1", "", "2"], ["2"]), ["1"]);
});

test("diffPanes：非数组入参抛 TypeError", () => {
  assert.throws(() => diffPanes("1" as unknown as string[], []), TypeError);
});

test("diffGoneRunning：gone 判定——running 且 paneId 消失 → taskId 入选", () => {
  const gone = runningTask("r1", "7");
  const alive = runningTask("r2", "8");
  assert.deepEqual(diffGoneRunning([gone, alive], ["8", "9"]), ["r1"]);
});

test("diffGoneRunning：非 running 任务 paneId 消失 → 不入选（paneGone 仅 running 生效）", () => {
  const doneTask = taskRecord({ taskId: "d1", status: "done" });
  doneTask.payload.spawn.paneId = "7";
  const queuedTask = taskRecord({ taskId: "q1", status: "queued" });
  queuedTask.payload.spawn.paneId = "8";
  assert.deepEqual(diffGoneRunning([doneTask, queuedTask], []), []);
});

test("diffGoneRunning：paneId 空串 → 不入选（spawn 未回写不可追踪）", () => {
  assert.deepEqual(diffGoneRunning([runningTask("r1", "")], []), []);
});

// ---------- buildDoneEvent / buildDoneText：通知形状 ----------

test("buildDoneEvent：done 摘要形状（taskId/role/status/耗时/exitCode，无恢复命令）", () => {
  const t = taskRecord({ taskId: "abcdef123456", status: "done", startedAt: 1000, updatedAt: 12_000 });
  t.result.exitCode = 0;
  t.result.sessionDir = "/tmp/sess";
  const ev = buildDoneEvent(t, "sess-uuid");
  assert.deepEqual(ev, {
    taskId: "abcdef123456",
    role: "explorer",
    status: "done",
    durationMs: 11_000,
    exitCode: 0,
  });
  assert.equal("resumeArgs" in ev, false);
});

test("buildDoneEvent：aborted/cancelled 附恢复命令行（buildResumeArgs 形状）", () => {
  for (const status of ["aborted", "cancelled"] as const) {
    const t = taskRecord({ taskId: "a1", status });
    t.result.sessionDir = "/tmp/sess";
    const ev = buildDoneEvent(t, "sess-uuid");
    assert.deepEqual(ev.resumeArgs, ["-p", "--session-dir", "/tmp/sess", "--session", "sess-uuid"]);
  }
});

test("buildDoneEvent：aborted 且 sessionId 不可解析 / sessionDir 空 → 无恢复命令", () => {
  const t = taskRecord({ taskId: "a1", status: "aborted" });
  t.result.sessionDir = "/tmp/sess";
  assert.equal("resumeArgs" in buildDoneEvent(t, null), false);
  const t2 = taskRecord({ taskId: "a2", status: "aborted" }); // sessionDir ""
  assert.equal("resumeArgs" in buildDoneEvent(t2, "sess-uuid"), false);
});

test("buildDoneEvent：非终态抛 TypeError", () => {
  assert.throws(() => buildDoneEvent(taskRecord({ taskId: "a1", status: "running" }), null), TypeError);
});

test("buildDoneText：aborted 行含恢复命令文本（摘要不塞全文）", () => {
  const t = taskRecord({ taskId: "abcdef123456", status: "aborted", startedAt: 1000, updatedAt: 46_000 });
  t.result.sessionDir = "/tmp/sess";
  const ev = buildDoneEvent(t, "sess-uuid");
  const text = buildDoneText([ev]);
  assert.match(text, /\[aborted\]/);
  assert.match(text, /abcdef12/);
  assert.match(text, /恢复：pi -p --session-dir "\/tmp\/sess" --session "sess-uuid"/);
});

test("isTerminalStatus：终态集合 = done/aborted/failed/cancelled", () => {
  for (const s of ["done", "aborted", "failed", "cancelled"] as const) {
    assert.equal(isTerminalStatus(s), true);
  }
  for (const s of ["queued", "running", "timeout"] as const) {
    assert.equal(isTerminalStatus(s), false);
  }
});

// ── wireFarm 装配路径（真 TaskStore 文件落盘 + 真子进程 pid + 假 display/pi/notify）──
// wireFarm 无条件装配（不读 isPaneMode；谁武装由 index.ts 按 ownDepth 分派决定）。
// ticker/probe 句柄由 start 武装、stop 清理；每个测试 t.after 兜底 stop + 删临时目录。

/** 本进程 owner（"pid+启动时间" 格式；pid 部分无真实进程，仅字符串消费） */
const WIRE_OWNER = "20000+1700000100000";

/** 轮询等待（装配路径用；cond 可返回 Promise） */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, pollMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: 条件 ${timeoutMs}ms 内未满足`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** 起真实子进程 → SIGKILL → 等 exit 回收：返回确定 ESRCH 的死 pid（跨重启补发数据源） */
async function deadChildPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  child.kill("SIGKILL");
  await once(child, "exit"); // node 已 reap：kill(pid, 0) 必为 ESRCH
  assert.equal(isPidAlive(pid), false, "SIGKILL 后 pid 探测应 ESRCH（前置条件）");
  return pid;
}

/** 空转 fake queue（store 为真 TaskStore；step 空报告，ticker 路径不产生决策） */
function idleQueue(store: TaskStore): Queue {
  return {
    store,
    step: async (): Promise<StepReport> => ({ now: Date.now(), decisions: [], notifications: [] }),
  } as unknown as Queue;
}

interface WireHarness {
  store: TaskStore;
  messages: FarmDoneMessage[];
  killSyncCalls: string[];
  loop: { start(): Promise<void>; stop(): Promise<void> };
}

/** 真 wireFarm + 真 TaskStore；display（记录 killSync）/pi（不注册钩子，手动 start/stop）/notify 为 fake */
function wireHarness(
  root: string,
  opts: {
    queue: Queue;
    store: TaskStore;
    tickIntervalMs?: number;
    probeIntervalMs?: number;
    busyDrainTimeoutMs?: number;
  },
): WireHarness {
  const messages: FarmDoneMessage[] = [];
  const killSyncCalls: string[] = [];
  const display: DisplayClient = {
    spawn: async () => "1",
    listPanes: async () => [],
    kill: async () => {},
    killSync: (paneId) => {
      killSyncCalls.push(paneId);
    },
  };
  const pi: FarmPi = { on: () => {} };
  const loop = wireFarm({
    queue: opts.queue,
    display,
    pi,
    owner: WIRE_OWNER,
    notify: async (message) => {
      messages.push(message);
    },
    farmRoot: root,
    now: () => Date.now(),
    tickIntervalMs: opts.tickIntervalMs ?? 1_000_000_000,
    probeIntervalMs: opts.probeIntervalMs ?? 1_000_000_000,
    busyDrainTimeoutMs: opts.busyDrainTimeoutMs,
  });
  return { store: opts.store, messages, killSyncCalls, loop };
}

test("wireFarm 无条件装配（不读 isPaneMode）：PI_AGENT_TEAMS_PANE=1 下仍注册 session 钩子 + start 后驱动 queue.step", async (t) => {
  const prev = process.env.PI_AGENT_TEAMS_PANE;
  process.env.PI_AGENT_TEAMS_PANE = "1";
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-t-pane-"));
  t.after(async () => {
    // 注意：process.env.X = undefined 会被 node 字符串化为 "undefined"（真值），
    // 后续 wireFarm 用例会误判 pane 形态 → 必须 delete 恢复缺省。
    if (prev === undefined) delete process.env.PI_AGENT_TEAMS_PANE;
    else process.env.PI_AGENT_TEAMS_PANE = prev;
    await rm(root, { recursive: true, force: true });
  });

  const onCalls: string[] = [];
  let stepCalls = 0;
  const store = new TaskStore(root);
  const queue = {
    store,
    step: async (): Promise<StepReport> => {
      stepCalls += 1;
      return { now: Date.now(), decisions: [], notifications: [] };
    },
  } as unknown as Queue;
  const loop = wireFarm({
    queue,
    display: { spawn: async () => "1", listPanes: async () => [], kill: async () => {}, killSync: () => {} },
    pi: {
      on(event: "session_start" | "session_shutdown"): void {
        onCalls.push(event);
      },
    },
    owner: WIRE_OWNER,
    notify: async () => {},
    farmRoot: root,
    tickIntervalMs: 1,
    probeIntervalMs: 1_000_000_000,
  });

  // 装配即注册钩子（不再读 isPaneMode 短路）；start 后 ticker 驱动 step
  assert.deepEqual(onCalls, ["session_start", "session_shutdown"]);
  await loop.start();
  await new Promise((resolve) => setTimeout(resolve, 30)); // 1ms 间隔必驱动 step
  await loop.stop();
  assert.ok(stepCalls > 0, "PI_AGENT_TEAMS_PANE=1 下仍武装 ticker 并驱动 queue.step");
});

test("wireFarm gcEnabled:false → GC 不执行（25h 旧 usage 文件保留）；缺省 true → sweep", async (t) => {
  const FIXED = 2_000_000_000_000;
  const old = new Date(FIXED - 25 * 3600 * 1000);

  // ① gcEnabled:false：旧 usage 文件保留
  const rootOff = await mkdtemp(join(tmpdir(), "pi-agent-teams-gc-off-"));
  t.after(() => rm(rootOff, { recursive: true, force: true }));
  await mkdir(join(rootOff, "usage"), { recursive: true });
  const offFile = join(rootOff, "usage", "old.json");
  await writeFile(offFile, "{}");
  await utimes(offFile, old, old);
  const storeOff = new TaskStore(rootOff);
  const loopOff = wireFarm({
    queue: idleQueue(storeOff),
    display: { spawn: async () => "1", listPanes: async () => [], kill: async () => {}, killSync: () => {} },
    pi: { on: () => {} },
    owner: WIRE_OWNER,
    notify: async () => {},
    farmRoot: rootOff,
    now: () => FIXED,
    tickIntervalMs: 1_000_000_000,
    probeIntervalMs: 10,
    gcEnabled: false,
  });
  await loopOff.start();
  await new Promise((resolve) => setTimeout(resolve, 50)); // 多轮 probe 周期
  await loopOff.stop();
  assert.equal(await readFile(offFile, "utf8"), "{}", "gcEnabled:false 不得 sweep");

  // ② 缺省 gcEnabled（true）：同构造旧 usage 文件被 sweep
  const rootOn = await mkdtemp(join(tmpdir(), "pi-agent-teams-gc-on-"));
  t.after(() => rm(rootOn, { recursive: true, force: true }));
  await mkdir(join(rootOn, "usage"), { recursive: true });
  const onFile = join(rootOn, "usage", "old.json");
  await writeFile(onFile, "{}");
  await utimes(onFile, old, old);
  const storeOn = new TaskStore(rootOn);
  const loopOn = wireFarm({
    queue: idleQueue(storeOn),
    display: { spawn: async () => "1", listPanes: async () => [], kill: async () => {}, killSync: () => {} },
    pi: { on: () => {} },
    owner: WIRE_OWNER,
    notify: async () => {},
    farmRoot: rootOn,
    now: () => FIXED,
    tickIntervalMs: 1_000_000_000,
    probeIntervalMs: 10,
  });
  await loopOn.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await loopOn.stop();
  await assert.rejects(readFile(onFile, "utf8"), "缺省 gcEnabled（true）应 sweep 25h 旧 usage 文件");
});

test("gcOnce 三目录 sweep：inbox/usage/presence 24h 旧文件全删、fresh 全留（逐文件级）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-gc-once-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = 3_000_000_000_000;
  const old = new Date(now - 25 * 3600 * 1000);
  const fresh = new Date(now - 3600 * 1000);

  const inboxPane = join(root, "inbox", "pane-1");
  await mkdir(inboxPane, { recursive: true });
  await mkdir(join(root, "usage"), { recursive: true });
  await mkdir(join(root, "presence"), { recursive: true });
  await writeFile(join(inboxPane, "old.json"), "{}");
  await writeFile(join(inboxPane, "fresh.json"), "{}");
  await writeFile(join(root, "usage", "old.json"), "{}");
  await writeFile(join(root, "usage", "fresh.json"), "{}");
  await writeFile(join(root, "presence", "old.json"), "{}");
  await writeFile(join(root, "presence", "fresh.json"), "{}");
  await utimes(join(inboxPane, "old.json"), old, old);
  await utimes(join(inboxPane, "fresh.json"), fresh, fresh);
  await utimes(join(root, "usage", "old.json"), old, old);
  await utimes(join(root, "usage", "fresh.json"), fresh, fresh);
  await utimes(join(root, "presence", "old.json"), old, old);
  await utimes(join(root, "presence", "fresh.json"), fresh, fresh);

  await gcOnce(root, now);

  // 三目录 old 全删、fresh 全留；inbox 同 pane 目录内 fresh 保留（逐文件级，非目录整删）
  await assert.rejects(readFile(join(inboxPane, "old.json"), "utf8"));
  assert.equal(await readFile(join(inboxPane, "fresh.json"), "utf8"), "{}");
  await assert.rejects(readFile(join(root, "usage", "old.json"), "utf8"));
  assert.equal(await readFile(join(root, "usage", "fresh.json"), "utf8"), "{}");
  await assert.rejects(readFile(join(root, "presence", "old.json"), "utf8"));
  assert.equal(await readFile(join(root, "presence", "fresh.json"), "utf8"), "{}");
});

test("wireFarm 装配：死 owner 未通知终态任务 → session_start 补发 farm.done（跨重启 US21；此前 scanTasks(owner) 预过滤此路径必超时）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-t-us21-"));
  const deadPid = await deadChildPid();
  const store = new TaskStore(root);
  const { messages, loop } = wireHarness(root, { queue: idleQueue(store), store });
  t.after(async () => {
    await loop.stop();
    await rm(root, { recursive: true, force: true });
  });

  // 旧会话（已退出）遗留的终态未通知任务：owner = 已死 pid（非本进程）
  const now = Date.now();
  await store.writeTask(
    taskRecord({
      taskId: "old-done",
      status: "done",
      owner: `${deadPid}+${now}`,
      createdAt: now - 60_000,
      updatedAt: now - 1_000,
      startedAt: now - 60_000,
      notifiedAt: 0,
    }),
  );

  await loop.start();
  await waitFor(() => messages.length >= 1, 1500);
  const ev = messages[0]!.events[0]!;
  assert.equal(ev.taskId, "old-done");
  assert.equal(ev.status, "done");

  // deliver 写回守卫：死 owner 任务 notifiedAt 同样写回（防每次重启重复补发）
  await waitFor(async () => (await store.readTask("old-done"))?.notifiedAt! > 0);
});

test("wireFarm 装配：终态事件单一来源——notifications（aborted/failed）驱动 farm.done，decisions 只补无通知动作的 done", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-t-notif-"));
  const store = new TaskStore(root);
  await store.writeTask(taskRecord({ taskId: "t-ab", status: "aborted", owner: WIRE_OWNER }));
  await store.writeTask(taskRecord({ taskId: "t-fa", status: "failed", owner: WIRE_OWNER }));
  await store.writeTask(taskRecord({ taskId: "t-do", status: "done", owner: WIRE_OWNER }));
  let steps = 0;
  const queue = {
    store,
    step: async (): Promise<StepReport> => {
      steps += 1;
      if (steps === 1) {
        return {
          now: Date.now(),
          decisions: [], // aborted/failed 不再依赖 decisions 重推导
          notifications: [
            { taskId: "t-ab", reason: "aborted" },
            { taskId: "t-fa", reason: "attemptsExhausted" },
          ],
        };
      }
      // done（paneDone 迁移行无 notifyMain 动作）→ 唯一仍走 decisions 的终态
      return { now: Date.now(), decisions: [{ taskId: "t-do", event: "paneDone" }], notifications: [] };
    },
  } as unknown as Queue;
  const { messages, loop } = wireHarness(root, { queue, store, tickIntervalMs: 10 });
  t.after(async () => {
    await loop.stop();
    await rm(root, { recursive: true, force: true });
  });

  await loop.start();
  await waitFor(() => messages.length >= 2, 5000);
  assert.deepEqual(
    messages[0]!.events.map((e) => [e.taskId, e.status]),
    [
      ["t-ab", "aborted"],
      ["t-fa", "failed"],
    ],
    "第 1 条：aborted+failed 同条聚合（消费 notifications 单一真源）",
  );
  assert.deepEqual(
    messages[1]!.events.map((e) => [e.taskId, e.status]),
    [["t-do", "done"]],
    "第 2 条：done 经 decisions（无 notifyMain 动作的终态路径）",
  );
});

test("wireFarm 装配：shutdown × in-flight spawn——stop 有界等 busy 闩排空，双扫 kill 迟到 paneId", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-t-race-"));
  const store = new TaskStore(root);
  let releaseSpawn!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    releaseSpawn = resolve;
  });
  let stepCalls = 0;
  const queue = {
    store,
    step: async (): Promise<StepReport> => {
      stepCalls += 1;
      if (stepCalls === 1) await inFlight; // 首个 step 模拟 executor.spawn 挂起（in-flight）
      return { now: Date.now(), decisions: [], notifications: [] };
    },
  } as unknown as Queue;
  const { killSyncCalls, loop } = wireHarness(root, { queue, store, tickIntervalMs: 10 });
  t.after(async () => {
    await loop.stop();
    await rm(root, { recursive: true, force: true });
  });

  await loop.start();
  await waitFor(() => stepCalls >= 1); // ticker 已进入 in-flight step（busy=true）

  const stopping = loop.stop(); // armed=false 后应等 busy 闩排空，双扫推迟到 spawn 完成
  // in-flight spawn 完成：paneId 落盘（无 drain 时此刻双扫已跑完 → 漏杀，此测试必挂）
  const rec = taskRecord({ taskId: "t-race", status: "running", owner: WIRE_OWNER, updatedAt: Date.now() });
  rec.payload.spawn.paneId = "p-race";
  await store.writeTask(rec);
  releaseSpawn();
  await stopping;

  assert.deepEqual(killSyncCalls, ["p-race"], "排空后双扫应拿到迟到 paneId 并 killSync");
  assert.equal((await store.readTask("t-race"))?.status, "cancelled");
});

test("wireFarm 装配：shutdown 杀 timeout pane——killSync 执行、状态不动（下次会话自然 retry）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-t-timeout-"));
  const store = new TaskStore(root);
  const { killSyncCalls, loop } = wireHarness(root, { queue: idleQueue(store), store });
  t.after(async () => {
    await loop.stop();
    await rm(root, { recursive: true, force: true });
  });

  const rec = taskRecord({ taskId: "t-timeout", status: "timeout", owner: WIRE_OWNER });
  rec.payload.spawn.paneId = "p-timeout";
  await store.writeTask(rec);

  await loop.start();
  await loop.stop();

  // 双扫各杀一次（killSync 幂等，spike §6 容忍 no such pane）；状态保持 timeout
  assert.deepEqual(killSyncCalls, ["p-timeout", "p-timeout"]);
  assert.equal((await store.readTask("t-timeout"))?.status, "timeout");
});

test("wireFarm 装配：session_start 回收死 owner 的 running 僵尸 → killSync 杀 pane + aborted + 补发 farm.done（释放全局并发位）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-t-zombie-"));
  const deadPid = await deadChildPid();
  const store = new TaskStore(root);
  const { messages, killSyncCalls, loop } = wireHarness(root, { queue: idleQueue(store), store });
  t.after(async () => {
    await loop.stop();
    await rm(root, { recursive: true, force: true });
  });

  const now = Date.now();
  // 僵尸：崩溃主会话遗留的 running（owner 进程已死）→ 先 killSync 再 paneAborted 注入 aborted
  const zombie = taskRecord({
    taskId: "zombie",
    status: "running",
    owner: `${deadPid}+${now}`,
    updatedAt: now - 1_000,
  });
  zombie.payload.spawn.paneId = "p-zombie";
  await store.writeTask(zombie);
  // 无 paneId 的僵尸（spawn 未回写）→ 不 killSync，仍 aborted
  await store.writeTask(
    taskRecord({
      taskId: "zombie-nopane",
      status: "running",
      owner: `${deadPid}+${now}`,
      updatedAt: now - 1_000,
    }),
  );
  // 活 owner 的 running（另一会话仍在跑）→ 不动
  await store.writeTask(
    taskRecord({ taskId: "alive-run", status: "running", owner: `${process.pid}+${now}`, updatedAt: now - 1_000 }),
  );
  // 本 owner 的 running → 不动
  await store.writeTask(
    taskRecord({ taskId: "mine-run", status: "running", owner: WIRE_OWNER, updatedAt: now - 1_000 }),
  );

  await loop.start();

  await waitFor(async () => (await store.readTask("zombie"))?.status === "aborted");
  // killSync 先于 aborted 落盘（同步顺序）：aborted 可见时僵尸 pane 必已杀
  assert.deepEqual(killSyncCalls, ["p-zombie"], "僵尸 pane killSync 杀；空 paneId 跳过；活/本 owner 不杀");
  assert.equal((await store.readTask("zombie-nopane"))?.status, "aborted", "空 paneId 僵尸跳过 kill 但仍 aborted");
  assert.equal((await store.readTask("alive-run"))?.status, "running", "活 owner 任务不被接管");
  assert.equal((await store.readTask("mine-run"))?.status, "running", "本 owner 任务不动");

  // aborted + 未通知 + owner 已死 → 同一次 session_start 的 replay 补发 farm.done
  await waitFor(() => messages.some((m) => m.events.some((e) => e.taskId === "zombie")), 1500);
  const ev = messages.flatMap((m) => m.events).find((e) => e.taskId === "zombie")!;
  assert.equal(ev.status, "aborted");
});

// ── 整改 4 轮：stale 快照 clobber / 短 drain tripwire ──

/**
 * 陈旧快照 store：scanTasks 返回 paneId 未写回的旧快照（模拟快照早于并发 spawn
 * 写回——drain 超时后 in-flight spawn 仍可落盘 paneId）；readTask/writeTask 走真
 * TaskStore（现读拿最新记录）。用于确定性验证 killAndCancelAll 落盘前现读。
 */
function staleSnapshotStore(store: TaskStore): TaskStore {
  return {
    scanTasks: async (owner?: string | null) => {
      const records = await store.scanTasks(owner);
      return records.map((rec) =>
        rec === null
          ? rec
          : { ...rec, payload: { ...rec.payload, spawn: { ...rec.payload.spawn, paneId: "" } } },
      );
    },
    readTask: (taskId: string) => store.readTask(taskId),
    writeTask: (record: TaskRecord) => store.writeTask(record),
  } as unknown as TaskStore;
}

test("wireFarm 装配：killAndCancelAll 落盘前 readTask 现读——stale 快照不 clobber 并发写回的 paneId（仍杀 pane + paneId 保留）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-t-stale-"));
  const store = new TaskStore(root);
  const { killSyncCalls, loop } = wireHarness(root, { queue: idleQueue(staleSnapshotStore(store)), store });
  t.after(async () => {
    await loop.stop();
    await rm(root, { recursive: true, force: true });
  });

  // 并发写回已落盘：快照（scanTasks）拿到的记录 paneId 为空，现读（readTask）有 paneId
  const rec = taskRecord({ taskId: "t-stale", status: "running", owner: WIRE_OWNER, updatedAt: Date.now() });
  rec.payload.spawn.paneId = "p-wb";
  await store.writeTask(rec);

  await loop.start();
  await loop.stop();

  // 双扫第一遍现读 → killSync + cancelled 落盘（paneId 保留）；第二遍见 cancelled 跳过
  assert.deepEqual(killSyncCalls, ["p-wb"], "现读 paneId 不空 → killSync；stale 快照会漏杀");
  const after = await store.readTask("t-stale");
  assert.equal(after?.status, "cancelled");
  assert.equal(after?.payload.spawn.paneId, "p-wb", "整记录落盘用现读记录：并发写回的 paneId 不被 stale 快照 clobber");
});

test("tripwire：slow spawn × 短 drain 超时——stop 返回后迟到 spawn 的 pane 仍被 kill（queue 侧 skip-kill 联动验证）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-t-drain-"));
  const store = new TaskStore(root);
  let releaseSpawn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSpawn = resolve;
  });
  let spawnCalls = 0;
  const executorKills: string[] = [];
  const executor: Executor = {
    spawn: async () => {
      spawnCalls += 1;
      await gate; // slow spawn：busyDrainTimeoutMs=50 超时后仍在飞
      return { paneId: "p-late", sessionDir: "/sessions/late" };
    },
    steer: async () => {},
    kill: async (paneId) => {
      executorKills.push(paneId);
    },
  };
  const queue = new Queue({ store, executor, owner: WIRE_OWNER });
  const { killSyncCalls, loop } = wireHarness(root, { queue, store, tickIntervalMs: 10, busyDrainTimeoutMs: 50 });
  t.after(async () => {
    await loop.stop();
    await rm(root, { recursive: true, force: true });
  });

  const now = Date.now();
  await store.writeTask(
    taskRecord({ taskId: "t-drain", status: "queued", owner: WIRE_OWNER, createdAt: now, updatedAt: now }),
  );

  await loop.start();
  await waitFor(() => spawnCalls >= 1); // dequeue → running 落盘 → spawn 挂起（busy 闩占位）

  // 短 drain：50ms 后超时继续双扫（不等挂起 spawn）；stop 必须在 spawn 完成前返回
  const stopped = await Promise.race([
    loop.stop().then(() => "stopped" as const),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  assert.equal(stopped, "stopped", "busyDrainTimeoutMs 超时后 stop 应返回，不等挂起 spawn");

  releaseSpawn(); // 迟到 spawn 返回：写回复查见 cancelled → 跳过写回 + best-effort kill（queue 侧 skip-kill）
  await waitFor(() => executorKills.includes("p-late"), 1500);
  assert.deepEqual(executorKills, ["p-late"], "迟到 pane 由 queue 侧 skip-kill 杀（spawn 返回值）；此断言失败 = 泄漏回归");
  assert.deepEqual(killSyncCalls, [], "取消落盘时 paneId 未写回，farm 侧无可杀（随后由 queue 侧兜底）");
  const rec = await store.readTask("t-drain");
  assert.equal(rec?.status, "cancelled");
  assert.equal(rec?.payload.spawn.paneId, "", "写回被 skip：陈旧 paneId 不覆盖 cancelled");
});
