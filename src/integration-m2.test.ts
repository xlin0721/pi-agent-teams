// src/integration-m2.test.ts
// E2E 独立集成测试（M2 src/ 全库，本文件为唯一新增文件）：真实模块串链——
// TaskStore 文件落盘 + Queue 决策/执行 + farm 循环（ticker/探测/聚合/补发/销毁）
// + spawnGate 降级链 + display CliError 透传——fake 终端层（Executor / cli runner）
// 与通知器。零依赖：node:test + node: 内置模块 + 相对导入带 .ts 扩展。
// 只断言外部行为（盘上 task record / step 报告 / 通知形状 / kill 记录）。
//
// 场景（任务书 1-8）：
//  1. 派发→出队→spawn→done 全链（wireFarm ticker 驱动 + farm.done 事件形状）
//  2. spawn 失败回队→用尽（attempts 0→1→2→failed + attemptsExhausted 通知）
//  3. L1 门（真 CliError 透传链 → spawnGate 判 L1 + 拒绝文案含内置 subagent 引导）
//  4. 迟到 done（timeout 后 done 信号 → 不重跑；陈旧 aborted 不误判）
//  5. pane 消失注入（真 diffGoneRunning + farm probe 循环 → aborted + 通知含恢复命令）
//  6. 补发跨重启（真 store 快照 + filterReplay pidAlive 注入）
//  6b. 补发跨重启（wireFarm 装配路径，spec 期望行为——修复后已绿，见测试报告）
//  7. 聚合（同 step 多终态 1 条 followUp；<2s 内第二次 step 不重复发）
//  8. shutdown 全 kill（killSync 记录 + queued/running → cancelled 落盘 + session 文件不删）
//  9. M3 翻转后 depth≥3 兜底：depth-2 恢复出队、depth-3 停留 queued
//  10. ownDepth 分派序 pin（presence 挂点 / depth-2 return / farm_status / assembleMiniFarm / wireFarm）
//  11. L1/L2 × form 叠加（spawnGate 拒绝 + tasks/ 零新增 + 源码序 pin：gate 在 writeTask 之前）

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TaskStore } from "./task-core/store.ts";
import type { TaskRecord } from "./task-core/store.ts";
import { Queue } from "./task-core/queue.ts";
import type { Executor } from "./task-core/queue.ts";
import {
  FLUSH_WINDOW_MS,
  buildDoneEvent,
  buildDoneText,
  filterReplay,
  wireFarm,
} from "./farm.ts";
import type { DisplayClient as FarmDisplayClient, FarmDoneMessage, FarmPi } from "./farm.ts";
import { degradeRejectText, spawnGate } from "./probe.ts";
import { CliError, DisplayClient } from "./display/split.ts";
import type { CliRunner } from "./display/split.ts";

// wireFarm 在 PI_AGENT_TEAMS_PANE 置位时退化为 no-op；本文件测试进程内禁用该环境变量
// （node --test 每个测试文件独立进程，不影响其他文件）。
delete process.env.PI_AGENT_TEAMS_PANE;

/** 测试 owner（"pid+启动时间" 格式；pid 部分无真实进程，仅字符串消费） */
const OWNER = "99999+1700000000000";

/** §13.3 全字段 task record fixture（测试按需覆写） */
function makeRecord(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  const t0 = 1_000;
  return {
    type: "spawn",
    parentId: null,
    depth: 1,
    status: overrides.status ?? "queued",
    owner: overrides.owner ?? OWNER,
    createdAt: overrides.createdAt ?? t0,
    updatedAt: overrides.updatedAt ?? t0,
    startedAt: overrides.startedAt ?? 0,
    nextAttemptAt: overrides.nextAttemptAt ?? 0,
    notifiedAt: overrides.notifiedAt ?? 0,
    timeoutSecs: overrides.timeoutSecs ?? 600,
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 2,
    backoffSecs: overrides.backoffSecs ?? [5, 30],
    payload: {
      spawn: { form: "tui", role: "explorer", prompt: "probe the thing", cwd: "", resumeFrom: null, paneId: "" },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: [], delivery: "notice", content: "" },
      schedule: { mode: "once", cron: "", intervalSecs: 0, onceAt: 0, lastRun: 0, nextRun: 0, firedTaskIds: [] },
    },
    result: { sessionDir: "", exitCode: null, cost: { model: "", inputTokens: 0, outputTokens: 0 } },
    ...overrides,
  };
}

/** 源码序 pin 共享 helper（评审整改 product#8 / 总监发现 #2 收敛）：在 src 中定位
 *  fnSig 所在函数体（fnSig 后第一个列 0 段注释 `\n// ──` 为区间上界；无段注释则到
 *  文件尾），断言 before 符号先于 after 符号。区间切割逻辑统一在此，防逐测试复制。
 *  纪律：逻辑层禁源码文本断言（见 docs-internal/agents/engineering-gates.md 测试纪律）；
 *  本 helper 仅用于装配层（index.ts）源码序回归锚点。 */
function assertOrderIn(src: string, fnSig: string, before: string, after: string): void {
  const fnStart = src.indexOf(fnSig);
  assert.ok(fnStart !== -1, `源码必须含 ${fnSig}`);
  const commentIdx = src.indexOf("\n// ──", fnStart);
  const fnEnd = commentIdx !== -1 ? commentIdx : src.length;
  const body = src.slice(fnStart, fnEnd);
  const beforeIdx = body.indexOf(before);
  const afterIdx = body.indexOf(after);
  assert.ok(beforeIdx !== -1, `${fnSig} 区间内必须含 ${before}`);
  assert.ok(afterIdx !== -1, `${fnSig} 区间内必须含 ${after}`);
  assert.ok(beforeIdx < afterIdx, `${before} 必须先于 ${after}（${fnSig} 区间内）`);
}

/** 可变时钟（epoch ms；queue 与 farm 共用同一来源） */
function mutableClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** 轮询等待（ticker 驱动场景用；cond 可返回 Promise） */
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

async function tmpFarmRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-agent-teams-it-"));
}

async function rmrf(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** wrapper 同款 done 信号落点（pane 侧唯一写者）：status/<taskId>.done = {exitCode, sessionDir}。
 *  同步落盘（审计收尾 C9）：两 done 信号同步写，25ms 真 ticker 无法在两次 await 间插入，
 *  场景7 两终态恒落同一 tick 窗口（聚合单条 followUp 断言稳定）。 */
async function writeDoneSignal(root: string, taskId: string, exitCode: number, sessionDir: string): Promise<void> {
  mkdirSync(join(root, "status"), { recursive: true });
  writeFileSync(join(root, "status", `${taskId}.done`), JSON.stringify({ exitCode, sessionDir }), "utf8");
}

/** fake Executor：spawn 记录 + 可选抛错/可选 onSpawn 钩子 */
function fakeExecutor(opts: {
  paneId?: string;
  sessionDir?: string;
  fail?: boolean;
  onSpawn?: (record: TaskRecord) => void | Promise<void>;
}): { executor: Executor; spawnCalls: TaskRecord[]; killCalls: string[] } {
  const spawnCalls: TaskRecord[] = [];
  const killCalls: string[] = [];
  const executor: Executor = {
    async spawn(record) {
      spawnCalls.push(record);
      if (opts.onSpawn !== undefined) await opts.onSpawn(record);
      if (opts.fail === true) throw new Error("wezterm cli split-pane 失败（fake）");
      return { paneId: opts.paneId ?? "42", sessionDir: opts.sessionDir ?? record.result.sessionDir };
    },
    async steer() {
      // M3 通道占位；队列不调用
    },
    async kill(taskId) {
      killCalls.push(taskId);
    },
  };
  return { executor, spawnCalls, killCalls };
}

interface FarmHarness {
  store: TaskStore;
  queue: Queue;
  messages: FarmDoneMessage[];
  killSyncCalls: string[];
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/** 装配真 farm 循环（真 TaskStore + 真 Queue + 真 wireFarm；display/notify/pi 为 fake） */
function assembleFarm(opts: {
  root: string;
  clock: () => number;
  executor: Executor;
  store?: TaskStore;
  displayPanes?: string[];
  tickIntervalMs?: number;
  probeIntervalMs?: number;
  allocateSessionDir?: (task: TaskRecord) => Promise<string>;
}): FarmHarness {
  const store = opts.store ?? new TaskStore(opts.root);
  const queue = new Queue({
    store,
    executor: opts.executor,
    maxConcurrency: 3,
    now: opts.clock,
    owner: OWNER,
    allocateSessionDir: opts.allocateSessionDir,
  });
  const messages: FarmDoneMessage[] = [];
  const killSyncCalls: string[] = [];
  const panes = opts.displayPanes ?? [];
  const display: FarmDisplayClient = {
    spawn: async () => "1",
    listPanes: async () => [...panes],
    kill: async () => {},
    killSync: (paneId) => {
      killSyncCalls.push(paneId);
    },
  };
  const pi: FarmPi = { on: () => {} };
  const loop = wireFarm({
    queue,
    display,
    pi,
    owner: OWNER,
    notify: async (message) => {
      messages.push(message);
    },
    farmRoot: opts.root,
    now: opts.clock,
    tickIntervalMs: opts.tickIntervalMs ?? 25,
    probeIntervalMs: opts.probeIntervalMs ?? 1_000_000_000,
  });
  return {
    store,
    queue,
    messages,
    killSyncCalls,
    start: () => loop.start(),
    stop: () => loop.stop(),
  };
}

// ── 场景1：派发→出队→spawn→done 全链 ───────────────────────────────────────

test("场景1：派发→出队→spawn→done 全链（真 store+queue+farm，fake Executor/notify）", async (t) => {
  const root = await tmpFarmRoot();
  const sessionDir = join(root, "sessions", "task-alpha");
  await mkdir(sessionDir, { recursive: true });
  const clock = mutableClock(1_000_000);
  const store = new TaskStore(root);
  // holder 对象而非 `let x = null`：规避 tsc 7（native）对函数内 let 初始化为 null 的
  // CFA 收窄缺陷（guard 后仍被判 null → never）；属性读无此问题。
  const spawnHook: {
    record: { status: string; startedAt: number; sessionDir: string } | null;
  } = { record: null };
  const { executor, spawnCalls, killCalls } = fakeExecutor({
    paneId: "42",
    sessionDir,
    onSpawn: async () => {
      // spawn 被调用的瞬间读盘：startedAt/sessionDir 必须先落盘（wrapper env 依赖）
      const rec = await store.readTask("task-alpha");
      spawnHook.record = {
        status: rec?.status ?? "",
        startedAt: rec?.startedAt ?? 0,
        sessionDir: rec?.result.sessionDir ?? "",
      };
    },
  });
  const { messages, start, stop } = assembleFarm({
    root,
    clock: clock.now,
    executor,
    store,
    tickIntervalMs: 25,
    probeIntervalMs: 1_000_000_000,
    allocateSessionDir: async () => sessionDir,
  });
  t.after(async () => {
    await stop();
    await rmrf(root);
  });

  // 派发（index.ts executeSpawn 同款落盘）：queued record 直接写盘
  const record = makeRecord({ taskId: "task-alpha", createdAt: clock.now(), updatedAt: clock.now() });
  record.payload.spawn.role = "explorer";
  await store.writeTask(record);

  await start(); // session_start：补发（无终态 → 无动作）+ 武装 25ms ticker
  await waitFor(() => spawnHook.record !== null); // 等到 spawn 钩子读盘完成
  assert.equal(spawnCalls.length, 1);

  // 出队先落盘：spawn 收到的 record 已带 startedAt/sessionDir，且盘上同态
  const persisted = spawnHook.record;
  if (persisted === null) assert.fail("spawn 前应已完成落盘");
  assert.equal(persisted.status, "running");
  assert.ok(persisted.startedAt > 0, "startedAt 先落盘");
  assert.equal(persisted.sessionDir, sessionDir, "sessionDir 先落盘");
  const spawned = spawnCalls[0]!;
  assert.equal(spawned.status, "running");
  assert.equal(spawned.startedAt, 1_000_000);

  // spawn 成功后 paneId/sessionDir 写回 task record（写回为 spawn 返回后的异步落盘，等盘）
  await waitFor(async () => (await store.readTask("task-alpha"))?.payload.spawn.paneId === "42");
  const running = await store.readTask("task-alpha");
  assert.equal(running?.status, "running");
  assert.equal(running?.result.sessionDir, sessionDir);

  // wrapper 写 done 信号（pane 侧唯一写者）→ 下一步 tick 仲裁 done
  clock.advance(5000);
  await writeDoneSignal(root, "task-alpha", 0, sessionDir);
  await waitFor(() => messages.length === 1);

  // 终态落盘 + notifiedAt 写回（notifiedAt 在 notify 之后异步写回，等盘）
  await waitFor(async () => (await store.readTask("task-alpha"))?.notifiedAt === 1_005_000);
  const final = await store.readTask("task-alpha");
  assert.equal(final?.status, "done");
  assert.equal(final?.result.exitCode, 0);
  assert.equal(final?.updatedAt, 1_005_000);
  assert.equal(final?.notifiedAt, 1_005_000);

  // farm.done 事件形状断言（taskId/role/status/耗时/exitCode）
  const msg = messages[0]!;
  assert.equal(msg.events.length, 1);
  const ev = msg.events[0]!;
  assert.equal(ev.taskId, "task-alpha");
  assert.equal(ev.role, "explorer");
  assert.equal(ev.status, "done");
  assert.equal(ev.durationMs, 5000);
  assert.equal(ev.exitCode, 0);
  assert.equal("resumeArgs" in ev, false); // done 无恢复命令
  assert.match(msg.text, /\[done\] task-alp explorer 完成 5\.0s exit=0/);
  assert.equal(killCalls.length, 0);
});

// ── 场景2：spawn 失败回队→用尽 ─────────────────────────────────────────────

test("场景2：spawn 失败回队→用尽（attempts 0→1→2→failed + attemptsExhausted 通知）", async (t) => {
  const root = await tmpFarmRoot();
  t.after(() => rmrf(root));
  const store = new TaskStore(root);
  const clock = mutableClock(1_000);
  const { executor, spawnCalls } = fakeExecutor({ fail: true });
  const queue = new Queue({ store, executor, maxConcurrency: 3, now: clock.now, owner: OWNER });
  await store.writeTask(
    makeRecord({
      taskId: "t-flaky",
      createdAt: 1_000,
      updatedAt: 1_000,
      attempts: 0,
      maxAttempts: 2,
      backoffSecs: [5, 30],
    }),
  );

  // 第 1 次：dequeue → spawn 抛错 → spawnFailed 回 queued，attempts 0→1，退避 5s 落盘
  const s1 = await queue.step();
  assert.ok(s1.decisions.some((d) => d.event === "dequeue"), "第一次应有 dequeue");
  assert.ok(s1.decisions.some((d) => d.event === "spawnFailed"), "第一次应有 spawnFailed");
  let rec = await store.readTask("t-flaky");
  assert.equal(rec?.status, "queued");
  assert.equal(rec?.attempts, 1);
  assert.equal(rec?.nextAttemptAt, 1_000 + 5_000);

  // 第 2 次：退避到点后重试 → 再失败 → attempts 1→2，退避 30s 落盘
  clock.advance(5000);
  const s2 = await queue.step();
  assert.ok(s2.decisions.some((d) => d.event === "spawnFailed"), "第二次应有 spawnFailed");
  rec = await store.readTask("t-flaky");
  assert.equal(rec?.status, "queued");
  assert.equal(rec?.attempts, 2);
  assert.equal(rec?.nextAttemptAt, 6_000 + 30_000);

  // 第 3 次：用尽 → failed 终态 + attemptsExhausted 通知
  clock.advance(30000);
  const s3 = await queue.step();
  assert.ok(s3.decisions.some((d) => d.event === "exhausted"), "用尽应有 exhausted");
  assert.deepEqual(s3.notifications, [{ taskId: "t-flaky", reason: "attemptsExhausted" }]);
  rec = await store.readTask("t-flaky");
  assert.equal(rec?.status, "failed");
  assert.equal(rec?.attempts, 2);
  assert.equal(spawnCalls.length, 3); // 三次出队均真实调 spawn
});

// ── 场景3：L1 门（真 CliError 透传链） ──────────────────────────────────────

test("场景3：L1 门——fake cli runner 抛 Socket stderr CliError → spawnGate 判 L1 + 拒绝文案含内置 subagent 引导", async () => {
  // 真 DisplayClient + fake runner：CliError（stderr 原文透传）沿真错误链上行
  const runner: CliRunner = async () => {
    throw new CliError(
      "wezterm cli --no-auto-start list --format json 失败: socket 连接失败",
      "failed to connect to Socket(/tmp/wezterm-gui.sock): Connection refused",
    );
  };
  const display = new DisplayClient(runner);
  const gate = await spawnGate({
    env: { TERM_PROGRAM: "WezTerm" },
    // index.ts executeSpawn 同款接线：listPanes 抛 CliError 原样上行
    list: async () => {
      const panes = await display.listPanes();
      return panes.length > 0 ? null : "";
    },
  });
  assert.equal(gate.level, "l1");
  assert.equal(gate.reason, "mux-unreachable");
  const text = degradeRejectText(gate);
  assert.match(text, /L1/);
  assert.match(text, /已拒绝派发/);
  assert.match(text, /内置 subagent 工具/);
});

test("场景3b：非 Socket 运行时错误 → l1/list-failed 同样拒派；L2 环境信号缺失 → 拒派；L0 正常放行", async () => {
  // L1 运行时错误（非 Socket stderr）
  const runnerOther: CliRunner = async () => {
    throw new CliError("wezterm cli 运行时错误", "wezterm: internal error");
  };
  const gateOther = await spawnGate({
    env: { TERM_PROGRAM: "WezTerm" },
    list: async () => {
      await new DisplayClient(runnerOther).listPanes();
      return "";
    },
  });
  assert.equal(gateOther.level, "l1");
  assert.equal(gateOther.reason, "list-failed");
  assert.match(degradeRejectText(gateOther), /内置 subagent 工具/);

  // L2：环境信号缺失
  const gateL2 = await spawnGate({ env: {}, list: async () => "" });
  assert.equal(gateL2.level, "l2");
  assert.equal(gateL2.reason, "env-signals-missing");
  assert.match(degradeRejectText(gateL2), /内置 subagent 工具/);

  // L0：真 DisplayClient + fake runner 返回真实 list JSON → 有 pane → 放行
  const runnerOk: CliRunner = async () => ({
    stdout: JSON.stringify([{ pane_id: 7, title: "main" }]),
    stderr: "",
  });
  const gateOk = await spawnGate({
    env: { WEZTERM_UNIX_SOCKET: "/tmp/wezterm-gui.sock" },
    list: async () => {
      const panes = await new DisplayClient(runnerOk).listPanes();
      return panes.length > 0 ? null : "";
    },
  });
  assert.equal(gateOk.level, "l0");
});

// ── 场景4：迟到 done（不重跑；陈旧 aborted 不误判） ─────────────────────────

test("场景4：迟到 done——timeout 后 done 信号 → 不重跑；旧 attempt 陈旧 aborted 不误判", async (t) => {
  const root = await tmpFarmRoot();
  t.after(() => rmrf(root));
  const store = new TaskStore(root);
  const clock = mutableClock(10_000);
  const { executor, spawnCalls, killCalls } = fakeExecutor({ paneId: "4" });
  const queue = new Queue({ store, executor, now: clock.now, owner: OWNER });
  await store.writeTask(
    makeRecord({
      taskId: "t-late",
      createdAt: 10_000,
      updatedAt: 10_000,
      timeoutSecs: 1,
      attempts: 0,
      maxAttempts: 2,
      backoffSecs: [5, 30],
    }),
  );

  const s1 = await queue.step(); // dequeue（startedAt = 10_000）
  assert.equal(spawnCalls.length, 1);
  let rec = await store.readTask("t-late");
  assert.equal(rec?.status, "running");
  assert.equal(rec?.startedAt, 10_000);

  // 旧 attempt 残留 aborted（mtime 早于 startedAt）→ 陈旧，不误判 paneAborted
  await mkdir(join(root, "status"), { recursive: true });
  const stalePath = join(root, "status", "t-late.aborted");
  await writeFile(stalePath, "stale", "utf8");
  await utimes(stalePath, new Date(5_000), new Date(5_000));
  clock.advance(100); // 10_100，未到 deadline
  const s2 = await queue.step();
  assert.deepEqual(s2.decisions, [], "陈旧 aborted 不应产生决策");
  rec = await store.readTask("t-late");
  assert.equal(rec?.status, "running");

  // deadline 触发 timeout + consumeSignal（陈旧 aborted 文件被消费）
  clock.advance(1000); // 11_100 ≥ 11_000
  const s3 = await queue.step();
  assert.ok(s3.decisions.some((d) => d.event === "deadline"));
  rec = await store.readTask("t-late");
  assert.equal(rec?.status, "timeout");
  await assert.rejects(readFile(stalePath, "utf8"), "陈旧 aborted 信号文件应被消费删除");

  // 迟到 done 信号 → done 修正，不重跑（无第二次 spawn、无 killPane）
  await writeDoneSignal(root, "t-late", 7, "");
  const s4 = await queue.step();
  assert.ok(s4.decisions.some((d) => d.event === "paneDone"));
  rec = await store.readTask("t-late");
  assert.equal(rec?.status, "done");
  assert.equal(rec?.result.exitCode, 7); // exitCode 取自信号
  assert.equal(spawnCalls.length, 1, "迟到 done 不重跑");
  assert.equal(killCalls.length, 0, "迟到 done 不触发 killPane");
  assert.equal(rec?.attempts, 0);
});

// ── 场景5：pane 消失注入（真 diffGoneRunning + farm probe 循环） ────────────

test("场景5：pane 消失注入——fake listPanes 少 pane → 差集 → step({paneGone}) → aborted + 通知含恢复命令", async (t) => {
  const root = await tmpFarmRoot();
  const sessionDir = join(root, "sessions", "t-gone");
  await mkdir(sessionDir, { recursive: true });
  const sessionId = "0e2f0e2f-1111-2222-3333-444455556666";
  // 真 findSessionId 数据源：sessions/<taskId>/<ts>_<uuid>.jsonl
  await writeFile(join(sessionDir, `200000_${sessionId}.jsonl`), "{}\n", "utf8");

  const clock = mutableClock(200_000);
  const { executor } = fakeExecutor({ paneId: "9", sessionDir });
  const { store, messages, start, stop } = assembleFarm({
    root,
    clock: clock.now,
    executor,
    displayPanes: ["1", "2"], // fake listPanes：pane 9 已消失
    tickIntervalMs: 1_000_000_000, // 关闭 ticker（防与探测交错）
    probeIntervalMs: 30,
  });
  t.after(async () => {
    await stop();
    await rmrf(root);
  });

  // running 任务（paneId 9 落盘）直接注入（wrapper 侧 pane 已被手动关闭）
  const record = makeRecord({ taskId: "t-gone", status: "running", startedAt: 200_000, updatedAt: 200_000 });
  record.payload.spawn.paneId = "9";
  record.result.sessionDir = sessionDir;
  await store.writeTask(record);

  await start(); // 探测循环 30ms：listPanes → diffGoneRunning → step({paneGone})
  await waitFor(() => messages.length === 1);
  // notifiedAt 在 notify 之后异步写回，等盘后再断言
  await waitFor(async () => (await store.readTask("t-gone"))?.notifiedAt === 200_000);

  const rec = await store.readTask("t-gone");
  assert.equal(rec?.status, "aborted");
  assert.equal(rec?.notifiedAt, 200_000);

  // 通知：aborted 事件附恢复命令行（buildResumeArgs 形状 + 摘要文本）
  const msg = messages[0]!;
  assert.equal(msg.events.length, 1);
  const ev = msg.events[0]!;
  assert.equal(ev.taskId, "t-gone");
  assert.equal(ev.status, "aborted");
  assert.deepEqual(ev.resumeArgs, ["-p", "--session-dir", sessionDir, "--session", sessionId]);
  assert.match(msg.text, /\[aborted\] t-gone explorer 中止/);
  assert.match(msg.text, /恢复：pi -p --session-dir .* --session "0e2f0e2f-1111-2222-3333-444455556666"/);
});

// ── 场景6：补发跨重启（真 store 快照 + filterReplay pidAlive 注入） ─────────

test("场景6：补发跨重启——终态未通知 + owner pid 已死 → filterReplay 命中；owner 活 → 排除", async (t) => {
  const root = await tmpFarmRoot();
  t.after(() => rmrf(root));
  const store = new TaskStore(root);
  const me = "4242+1700000000000";
  const now = 500_000;

  await store.writeTask(makeRecord({
    taskId: "mine-done",
    status: "done",
    owner: me,
    createdAt: now - 2_000,
    updatedAt: now - 1_000,
    startedAt: now - 2_000,
    notifiedAt: 0,
  }));
  await store.writeTask(makeRecord({
    taskId: "dead-done",
    status: "done",
    owner: "1111+1700000000000", // 旧 owner（进程已死）
    createdAt: now - 3_000,
    updatedAt: now - 2_000,
    startedAt: now - 3_000,
    notifiedAt: 0,
  }));
  const dead = await store.readTask("dead-done");
  dead!.result.exitCode = 3;
  await store.writeTask(dead!);
  await store.writeTask(makeRecord({
    taskId: "alive-done",
    status: "done",
    owner: "2222+1700000000000", // 旧 owner（进程仍活：双会话防重）
    createdAt: now - 4_000,
    updatedAt: now - 3_000,
    startedAt: now - 4_000,
    notifiedAt: 0,
  }));
  await store.writeTask(makeRecord({
    taskId: "mine-notified",
    status: "done",
    owner: me,
    createdAt: now - 5_000,
    updatedAt: now - 4_000,
    startedAt: now - 5_000,
    notifiedAt: now - 100,
  }));
  await store.writeTask(makeRecord({
    taskId: "mine-running",
    status: "running",
    owner: me,
    createdAt: now - 6_000,
    updatedAt: now - 5_000,
    startedAt: now - 6_000,
    notifiedAt: 0,
  }));

  // 真 store 快照（wireFarm replay 同源数据）→ filterReplay + pidAlive 注入
  const all = await store.scanTasks(null);
  const probes: number[] = [];
  const pidAlive = (pid: number): boolean => {
    probes.push(pid);
    return pid === 2222; // 1111 死、2222 活
  };
  const due = filterReplay(all, me, now, pidAlive);
  assert.deepEqual(
    due.map((task) => task.taskId),
    ["dead-done", "mine-done"], // updatedAt 升序
    "dead owner + 未通知入选；alive owner / 已通知 / 非终态排除",
  );
  assert.deepEqual(probes, [2222, 1111], "仅探测非本 owner 的 pid，且每个 pid 只探测一次");

  // 链上 buildDoneEvent/buildDoneText：补发事件形状（farm.done 同口径）
  const events = due.map((task) => buildDoneEvent(task, null));
  assert.equal(events[0]!.taskId, "dead-done");
  assert.equal(events[0]!.status, "done");
  assert.equal(events[0]!.exitCode, 3);
  assert.equal(events[0]!.durationMs, 1_000);
  const text = buildDoneText(events);
  assert.match(text, /\[done\] dead-don/);
  assert.match(text, /\[done\] mine-don/);
});

test("场景6b：补发跨重启（wireFarm 装配路径）——旧 owner 进程已死，session_start 应补发旧任务通知", async (t) => {
  const root = await tmpFarmRoot();
  // 制造一个真实死亡的 pid：起子进程 → SIGKILL → pid 确定 ESRCH
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const deadPid = child.pid!;
  child.kill("SIGKILL");
  await once(child, "exit");

  const { executor } = fakeExecutor({ paneId: "42" });
  const { store, messages, start, stop } = assembleFarm({
    root,
    clock: () => Date.now(),
    executor,
    tickIntervalMs: 25,
    probeIntervalMs: 1_000_000_000,
  });
  t.after(async () => {
    await stop();
    await rmrf(root);
  });

  // 旧会话（已退出）遗留的终态未通知任务：owner = 已死 pid
  const now = Date.now();
  const old = makeRecord({
    taskId: "old-task",
    status: "done",
    owner: `${deadPid}+${now}`,
    createdAt: now - 60_000,
    updatedAt: now - 1_000,
    startedAt: now - 6_000,
    notifiedAt: 0,
  });
  old.result.exitCode = 0;
  await store.writeTask(old);

  // PRD §13.2：session_start 补发（owner==本进程 或 owner 进程已死 + 终态 + 未通知 + ≤24h）
  await start();
  await waitFor(() => messages.length >= 1, 1500);
  const ev = messages[0]!.events[0]!;
  assert.equal(ev.taskId, "old-task");
  assert.equal(ev.status, "done");
  assert.equal(ev.exitCode, 0);
});

// ── 场景7：通知聚合（同 step 多终态 1 条；<2s 不重复发） ────────────────────

test("场景7：聚合——同 step 多终态 → 一条 followUp；<2s 内第二次 step → 不重复发", async (t) => {
  const root = await tmpFarmRoot();
  const clock = mutableClock(100_000);
  const { executor } = fakeExecutor({ paneId: "42" });
  const { store, messages, start, stop } = assembleFarm({
    root,
    clock: clock.now,
    executor,
    tickIntervalMs: 25,
    probeIntervalMs: 1_000_000_000,
  });
  t.after(async () => {
    await stop();
    await rmrf(root);
  });

  await store.writeTask(makeRecord({ taskId: "aaa-t1", createdAt: 100_000, updatedAt: 100_000 }));
  await store.writeTask(makeRecord({ taskId: "bbb-t2", createdAt: 100_001, updatedAt: 100_001 }));
  await start();

  // 同 tick 出队 → 各自 running → 两个 done 信号落在同一 tick 窗口内
  await waitFor(async () =>
    (await store.readTask("aaa-t1"))?.status === "running" &&
    (await store.readTask("bbb-t2"))?.status === "running",
  );
  await writeDoneSignal(root, "aaa-t1", 0, "");
  await writeDoneSignal(root, "bbb-t2", 0, "");
  await waitFor(() => messages.length === 1);
  assert.deepEqual(
    messages[0]!.events.map((e) => e.taskId),
    ["aaa-t1", "bbb-t2"],
    "一次 step 双终态 → 一条 followUp 携带两事件",
  );

  // 第三个任务完成：距上次 flush <2s（时钟未推进）→ hold，不重复发
  await store.writeTask(makeRecord({ taskId: "ccc-t3", createdAt: 100_002, updatedAt: 100_002 }));
  await waitFor(async () => (await store.readTask("ccc-t3"))?.status === "running");
  await writeDoneSignal(root, "ccc-t3", 0, "");
  await waitFor(async () => (await store.readTask("ccc-t3"))?.status === "done");
  await new Promise((resolve) => setTimeout(resolve, 200)); // 多等数个 tick
  assert.equal(messages.length, 1, "聚合窗口未到：不重复发");

  // 窗口 ≥2s 后下一次 step 续发（时钟推进即窗口到期）
  clock.advance(FLUSH_WINDOW_MS + 500);
  await waitFor(() => messages.length === 2);
  assert.deepEqual(messages[1]!.events.map((e) => e.taskId), ["ccc-t3"]);
});

// ── 场景8：shutdown 全 kill（killSync + cancelled 落盘 + session 文件不删） ──

test("场景8：shutdown 全 kill——killSync 记录 + queued/running → cancelled 落盘 + session 文件不删", async (t) => {
  const root = await tmpFarmRoot();
  const sessionDir = join(root, "sessions", "t-run");
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "300000_00000000-aaaa-bbbb-cccc-dddddddddddd.jsonl");
  await writeFile(sessionFile, '{"line":1}\n', "utf8");

  const clock = mutableClock(300_000);
  const { executor } = fakeExecutor({ paneId: "77", sessionDir });
  const { store, killSyncCalls, start, stop } = assembleFarm({
    root,
    clock: clock.now,
    executor,
    tickIntervalMs: 1_000_000_000,
    probeIntervalMs: 1_000_000_000,
  });
  t.after(async () => {
    await stop();
    await rmrf(root);
  });

  const running = makeRecord({ taskId: "t-run", status: "running", startedAt: 300_000, updatedAt: 300_000 });
  running.payload.spawn.paneId = "77";
  running.result.sessionDir = sessionDir;
  await store.writeTask(running);
  await store.writeTask(makeRecord({ taskId: "t-queued", status: "queued", createdAt: 300_001, updatedAt: 300_001 }));

  await start();
  await stop(); // session_shutdown：同步全 kill + cancelled 落盘

  assert.deepEqual(killSyncCalls, ["77"], "running pane 被 killSync；queued 无 pane 不 kill");
  const r = await store.readTask("t-run");
  const q = await store.readTask("t-queued");
  assert.equal(r?.status, "cancelled");
  assert.equal(q?.status, "cancelled");
  assert.equal(r?.updatedAt, 300_000);

  // kill 不删 session 文件（回收归 GC 3d 口径）
  assert.equal(await readFile(sessionFile, "utf8"), '{"line":1}\n');

  // stop 幂等：再次 stop 不重复 kill、状态不变
  await stop();
  assert.deepEqual(killSyncCalls, ["77"]);
});

// ── 场景9：depth≥3 兜底守卫（M3 翻转：depth-2 恢复出队） ────

test("场景9：depth≥3 守卫——depth=2 queued 出队（spawn 恰 1 次）、depth=3 停留 queued 零 spawn", async (t) => {
  const root = await tmpFarmRoot();
  t.after(() => rmrf(root));
  const store = new TaskStore(root);
  const clock = mutableClock(900_000);
  const { executor, spawnCalls } = fakeExecutor({ paneId: "42" });
  const queue = new Queue({ store, executor, maxConcurrency: 3, now: clock.now, owner: OWNER });

  // 注入 depth=2 + depth=3（均 queued）：M3 翻转后 depth-2 恢复出队、depth-3 停留 queued
  await store.writeTask(
    makeRecord({ taskId: "t-depth2", depth: 2, createdAt: 900_000, updatedAt: 900_000 }),
  );
  await store.writeTask(
    makeRecord({ taskId: "t-depth3", depth: 3, createdAt: 900_001, updatedAt: 900_001 }),
  );

  const report = await queue.step();
  assert.ok(
    report.decisions.some((d) => d.event === "dequeue" && d.taskId === "t-depth2"),
    "depth-2 恢复出队",
  );
  assert.ok(
    !report.decisions.some((d) => d.event === "dequeue" && d.taskId === "t-depth3"),
    "depth≥3 不得产生 dequeue 决策",
  );
  assert.equal(spawnCalls.length, 1, "fake executor.spawn 仅 depth-2 一次（depth-3 零调用）");
  assert.equal(spawnCalls[0]?.taskId, "t-depth2");

  const depth2 = await store.readTask("t-depth2");
  assert.equal(depth2?.status, "running", "depth-2 出队变 running");
  assert.ok((depth2?.startedAt ?? 0) > 0, "depth-2 出队写 startedAt");
  const depth3 = await store.readTask("t-depth3");
  assert.equal(depth3?.status, "queued", "depth-3 停留 queued");
  assert.equal(depth3?.startedAt, 0, "depth-3 不出队即不写 startedAt");
});

// ── 场景10：PI_AGENT_TEAMS_PANE 语义显式化（挂账②：wrapper env 契约 + 装配序契约） ──

test("场景10：PI_AGENT_TEAMS_PANE 契约 + index.ts ownDepth 分派序——wrapper export=1；depth-2 早退先于 spawn；farm_status 在 return 后 assembleMiniFarm 前", async () => {
  const srcDir = dirname(fileURLToPath(import.meta.url));

  // ① wrapper env 契约：assets/wrapper.sh 必须 export PI_AGENT_TEAMS_PANE=1，且位于
  //    pi 启动（PI_PID=$!）之前——pane 内 pi 继承该值 → 不武装嵌套农场。
  const wrapper: string = await readFile(join(srcDir, "..", "assets", "wrapper.sh"), "utf8");
  const exportMatch = /export PI_AGENT_TEAMS_PANE=1/.exec(wrapper);
  assert.ok(exportMatch !== null, "wrapper.sh 必须含 export PI_AGENT_TEAMS_PANE=1");
  const piLaunchIdx = wrapper.indexOf("PI_PID=$!");
  assert.ok(piLaunchIdx !== -1, "wrapper.sh 必须含 pi launch 点（PI_PID=$!）");
  assert.ok(
    exportMatch.index < piLaunchIdx,
    "export 必须先于 pi 启动（launch 之后注入无效）",
  );

  // ② index.ts 装配序契约（ownDepth 分派；grep 断言：index.ts 有 SDK import 不可单测）：
  //    wirePanePresence 挂点在 depth-2 return 之前（BE#3）→ depth-2 早退先于
  //    spawn_visible_agent → farm_status 在 return 之后、assembleMiniFarm( 之前 →
  //    assembleMiniFarm( 先于 main 的 wireFarm({。全部收敛为 assertOrderIn
  //    （共享区间切割 helper，总监发现 #2）；piAgentTeamsExtension 为区间锚点。
  const indexSrc: string = await readFile(join(srcDir, "index.ts"), "utf8");
  const ASSEMBLY = "export default function piAgentTeamsExtension(";
  assertOrderIn(indexSrc, ASSEMBLY, "wirePanePresence(store, ownDepthValue)", "ownDepthValue >= 2) return");
  assertOrderIn(indexSrc, ASSEMBLY, "ownDepthValue >= 2) return", 'name: "spawn_visible_agent"');
  assertOrderIn(indexSrc, ASSEMBLY, "ownDepthValue >= 2) return", 'name: "farm_status"');
  assertOrderIn(indexSrc, ASSEMBLY, 'name: "farm_status"', "assembleMiniFarm(pi, {");
  assertOrderIn(indexSrc, ASSEMBLY, "assembleMiniFarm(pi, {", "wireFarm({");
});

// ── 场景11：L1/L2 × form 叠加（评审整改 product#8：spawnGate 在 writeTask 之前） ──

test("场景11：form:\"worker\" + L1 环境（bogus socket）→ spawnGate 拒绝且 tasks/ 零新增", async (t) => {
  const root = await tmpFarmRoot();
  t.after(() => rmrf(root));
  const store = new TaskStore(root);

  // L1 环境：信号在位（非 L2），mux 不可达（Socket stderr）→ l1/mux-unreachable。
  // form（tui|worker）不参与 gate 判定——worker 形态同样先过门（form 参数票 02 才
  // 落；executeSpawn 现序 = spawnGate → writeTask，下方以真 TaskStore 锁定该序）。
  const gate = await spawnGate({
    env: { TERM_PROGRAM: "WezTerm" },
    list: async () => {
      throw new CliError(
        "wezterm cli --no-auto-start list 失败",
        "failed to connect to Socket(/tmp/bogus.sock): Connection refused",
      );
    },
  });
  assert.equal(gate.level, "l1");
  assert.equal(gate.reason, "mux-unreachable");
  assert.match(degradeRejectText(gate), /已拒绝派发，任务未落盘/);

  // executeSpawn 同款顺序：gate.level !== "l0" → 直接返回拒绝文案，不 writeTask
  // → tasks/ 零新增（防 form 处理前移破坏降级门：任务不落盘不静默丢失）。
  assert.deepEqual(await store.scanTasks(null), [], "L1 拒派必须 tasks/ 零新增");

  // 源码序断言（评审整改 product#8 的回归锚点，与场景10 共享 assertOrderIn）：
  // executeSpawn 函数体内 spawnGate( 调用先于 writeTask( 调用——若 form 处理前移
  // （writeTask 先于 gate）或降级门后移，此断言必红。区间上界 = 函数后第一个列 0
  // 段注释（函数体内注释均缩进，不会误截断），不误匹配其他函数的同名符号。
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const indexSrc: string = await readFile(join(srcDir, "index.ts"), "utf8");
  assertOrderIn(indexSrc, "async function executeSpawn(", "spawnGate(", "writeTask(");
});

// ── 场景12：B 形态 headless pi env 继承（US8，评审整改 FE#6/PR#3/BE#6） ──
//
// wrapper.sh B 分支（PI_AGENT_TEAMS_FORM=worker）经 `node "$PI_RENDERER" < /dev/tty &` 起
// 渲染器，渲染器再 pipe spawn headless pi——两层子进程都必须继承 PI_AGENT_TEAMS_PANE=1
// （wrapper 保证 export，见场景10 契约）。断言取可测接缝：render-mini.ts 的 spawnPi
// 零 env 覆写（spawn(piBinary, argv, { cwd, stdio })）→ 直接继承 process.env，故以
// 假 pi shim（PI_SCRIPT=node 脚本）落盘读到的 process.env.PI_AGENT_TEAMS_PANE 断言继承不断链。
// 语义：B 形态 headless pi 恒带 --approve 且继承 PI_AGENT_TEAMS_PANE=1——farm 项目 .pi/
// 资源不静默失效、pane 内实例不武装 farm（US8）。

test("场景12：B 形态 headless pi 经 env 继承拿到 PI_AGENT_TEAMS_PANE=1（假 pi shim 落盘）", async (t) => {
  const root = await tmpFarmRoot();
  t.after(() => rmrf(root));
  const shimOut = join(root, "pane.out");
  const shimPath = join(root, "shim.cjs");
  // 假 pi shim：读 env 落盘后退出（不 spawn 真 pi；stdout 静默 = runRenderer 无事件）。
  await writeFile(
    shimPath,
    'require("node:fs").writeFileSync(process.env.SHIM_OUT, String(process.env.PI_AGENT_TEAMS_PANE)); process.exit(0);\n',
    "utf8",
  );
  const renderMiniPath = join(dirname(fileURLToPath(import.meta.url)), "display", "render-mini.ts");
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      renderMiniPath,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_AGENT_TEAMS_PANE: "1",
        PI_AGENT_TEAMS_DEPTH: "2", // depth-2 worker 场景
        PI_AGENT_TEAMS_TASK_ID: "t-headless",
        SESS_DIR: join(root, "sessions", "t-headless"),
        PI_BIN: process.execPath,
        PI_SCRIPT: shimPath,
        SHIM_OUT: shimOut,
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (d: unknown) => { stderr += String(d); });
  const code = await new Promise<number | null>((resolve) => child.on("exit", (c: number | null) => resolve(c)));
  assert.equal(code, 0, `render-mini 应正常退出（shim exit 0），stderr: ${stderr}`);
  // shim 先写文件再 exit：render-mini 退出时 shim 已落盘。
  assert.equal(
    await readFile(shimOut, "utf8"),
    "1",
    "headless pi（假 shim）必须经 env 继承拿到 PI_AGENT_TEAMS_PANE=1",
  );
});
