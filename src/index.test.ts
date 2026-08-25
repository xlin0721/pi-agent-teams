// src/index.test.ts
// 06 装配票单测：
// 1) farm_status 侧纯渲染（fake tasks 数组：表头/行内容/排序/耗时 startedAt 口径/
//    「会话保留 7 天」尾部提示/空列表）、<taskId> 详情渲染、--status 过滤枚举校验、
//    nextAttemptAt/resumeCommandLine 边界（全部纯函数、零 I/O）。
// 2) 修复轮「装配契约」测试：display 适配层契约（PaneInfo 对象数组 → pane_id
//    字符串）→ farm 探测 seam——真 TaskStore/Queue/wireFarm + 真 adaptListPanes
//    （display/adapt.ts，与 index.ts 装配同一来源）+ fake display/notify，tmp 目录
//    I/O；断言 pane 存活不误判 gone（无 aborted 注入/通知）、pane 真消失仍能差集
//    探测。仍零 pi SDK import（index.ts 的 SDK 装配不在此单测，归 08 smoke）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FARM_STATUS_VALUES,
  durationText,
  formatNextAttemptAt,
  renderFarmTable,
  renderTaskDetail,
  resumeCommandLine,
  sortTasksForDisplay,
  validateStatusFilter,
} from "./probe.ts";
import type { TaskRecord } from "./task-core/store.ts";
import { TaskStore } from "./task-core/store.ts";
import { Queue } from "./task-core/queue.ts";
import type { Executor } from "./task-core/queue.ts";
import { wireFarm } from "./farm.ts";
import type { FarmDoneMessage } from "./farm.ts";
import type { PaneInfo } from "./display/protocol.ts";
import { adaptListPanes } from "./display/adapt.ts";

/** §13.3 全字段 fake task record（字段可覆盖）。 */
function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-0001",
    type: "spawn",
    parentId: null,
    depth: 1,
    status: "queued",
    owner: "pid+start",
    createdAt: 1_000,
    updatedAt: 1_000,
    startedAt: 0,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs: 600,
    attempts: 0,
    maxAttempts: 2,
    backoffSecs: [5, 30],
    payload: {
      spawn: { form: "tui", role: "worker", prompt: "do the thing", cwd: "/tmp/p1", resumeFrom: null, paneId: "7" },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: ["all"], delivery: "notice", content: "" },
      schedule: {
        mode: "once",
        cron: "",
        intervalSecs: 0,
        onceAt: 0,
        lastRun: 0,
        nextRun: 0,
        firedTaskIds: [],
      },
    },
    result: { sessionDir: "", exitCode: null, cost: { model: "", inputTokens: 0, outputTokens: 0 } },
    ...overrides,
  };
}

const NOW = 10_000;

// wireFarm 在 PI_AGENT_TEAMS_PANE 置位时退化为 no-op；本文件测试进程内禁用该环境变量
// （node --test 每个测试文件独立进程，不影响其他文件）。
delete process.env.PI_AGENT_TEAMS_PANE;

// ── renderFarmTable（5 列表格） ─────────────────────────────────────────────

test("renderFarmTable: 表头 5 列（taskId 前 8 位/role/status/attempts/耗时）+ 尾部「会话保留 7 天」", () => {
  const text = renderFarmTable([], NOW);
  const lines = text.split("\n");
  assert.equal(lines[0], "taskId   role         status   attempts 耗时");
  assert.match(text, /共 0 个任务 · 会话保留 7 天/);
});

test("renderFarmTable: 行内容——taskId 前 8 位截断、role/status 标签、attempts 分数、耗时", () => {
  const task = makeTask({
    taskId: "abcdef1234567890",
    status: "running",
    startedAt: NOW - 1500,
    attempts: 1,
    maxAttempts: 2,
    payload: {
      ...makeTask().payload,
      spawn: { ...makeTask().payload.spawn, role: "explorer" },
    },
  });
  const lines = renderFarmTable([task], NOW).split("\n");
  assert.equal(lines.length, 3); // 表头 + 1 行 + 尾部提示
  const row = lines[1]!;
  assert.ok(row.startsWith("abcdef12"), `taskId 前 8 位：${row}`);
  assert.match(row, /explorer/);
  assert.match(row, /运行中/);
  assert.match(row, /1\/2/);
  assert.match(row, /1\.5s/);
});

test("renderFarmTable: 耗时 startedAt 口径——未 started → —；running → now-startedAt；done → updatedAt-startedAt", () => {
  const queued = makeTask({ taskId: "q1", status: "queued", startedAt: 0, createdAt: 100 });
  const running = makeTask({ taskId: "r1", status: "running", startedAt: 6_000, updatedAt: 6_000, createdAt: 200 });
  const done = makeTask({
    taskId: "d1",
    status: "done",
    startedAt: 1_000,
    updatedAt: 4_000,
    createdAt: 300,
    result: { ...makeTask().result, exitCode: 0 },
  });
  const text = renderFarmTable([queued, running, done], NOW);
  const qRow = text.split("\n")[1]!;
  const rRow = text.split("\n")[2]!;
  const dRow = text.split("\n")[3]!;
  assert.match(qRow, /—/);
  assert.match(rRow, /4\.0s/);
  assert.match(dRow, /3\.0s/);
  assert.match(dRow, /完成/);
});

test("renderFarmTable: 行按 createdAt 升序（taskId 破序），role 缺失显示 -", () => {
  const later = makeTask({ taskId: "b1", createdAt: 200 });
  const earlier = makeTask({ taskId: "a1", createdAt: 100 });
  const noRole = makeTask({
    taskId: "c1",
    createdAt: 300,
    payload: { ...makeTask().payload, spawn: { ...makeTask().payload.spawn, role: "" } },
  });
  const lines = renderFarmTable([later, earlier, noRole], NOW).split("\n");
  assert.match(lines[1]!, /a1/);
  assert.match(lines[2]!, /b1/);
  assert.match(lines[3]!, /c1/);
  assert.match(lines[3]!, /-/);
});

test("sortTasksForDisplay: 不修改入参顺序（纯函数，返回新数组）", () => {
  const tasks = [makeTask({ taskId: "z", createdAt: 3 }), makeTask({ taskId: "a", createdAt: 1 })];
  const sorted = sortTasksForDisplay(tasks);
  assert.equal(tasks[0]!.taskId, "z");
  assert.equal(sorted[0]!.taskId, "a");
});

// ── renderTaskDetail（<taskId> 详情） ───────────────────────────────────────

test("renderTaskDetail: 完整 taskId/role/status/attempts/nextAttemptAt/耗时齐全", () => {
  const task = makeTask({
    taskId: "abcdef1234567890",
    status: "running",
    startedAt: NOW - 2000,
    attempts: 1,
    nextAttemptAt: NOW + 5000,
    payload: {
      ...makeTask().payload,
      spawn: { ...makeTask().payload.spawn, role: "tech-director" },
    },
  });
  const text = renderTaskDetail(task, null, NOW);
  assert.match(text, /taskId: abcdef1234567890/);
  assert.match(text, /role: tech-director/);
  assert.match(text, /form: tui/);
  assert.match(text, /status: 运行中 \(running\)/);
  assert.match(text, /attempts: 1\/2/);
  assert.match(text, /nextAttemptAt: .*（5\.0s 后）/);
  assert.match(text, /耗时: 2\.0s/);
});

test("renderTaskDetail: form worker（票 06）", () => {
  const task = makeTask({
    taskId: "w1",
    payload: {
      ...makeTask().payload,
      spawn: { ...makeTask().payload.spawn, form: "worker" },
    },
  });
  const text = renderTaskDetail(task, null, NOW);
  assert.match(text, /form: worker/);
});

test("renderTaskDetail: 恢复命令 = buildResumeArgs 组装成 pi -p 完整命令行", () => {
  const task = makeTask({
    taskId: "k1",
    status: "cancelled",
    result: {
      ...makeTask().result,
      sessionDir: "/Users/x/.pi-agent-teams/sessions/k1",
      exitCode: null,
    },
  });
  const text = renderTaskDetail(task, "0e2f0e2f-1111-2222-3333-444455556666", NOW);
  assert.match(
    text,
    /恢复命令: pi -p --session-dir "\/Users\/x\/\.pi-agent-teams\/sessions\/k1" --session "0e2f0e2f-1111-2222-3333-444455556666"/,
  );
});

test("renderTaskDetail: sessionDir 空/sessionId 不可解析 → 恢复命令不可用", () => {
  const noSessionDir = makeTask({ taskId: "k2", status: "cancelled" });
  assert.match(renderTaskDetail(noSessionDir, null, NOW), /恢复命令: 不可用/);

  const noSessionId = makeTask({
    taskId: "k3",
    status: "cancelled",
    result: { ...makeTask().result, sessionDir: "/x/sessions/k3" },
  });
  assert.match(renderTaskDetail(noSessionId, null, NOW), /恢复命令: 不可用/);
});

test("renderTaskDetail: exitCode 为 number 时附带一行；null 不显示", () => {
  const withExit = makeTask({
    taskId: "k4",
    status: "done",
    result: { ...makeTask().result, exitCode: 1 },
  });
  assert.match(renderTaskDetail(withExit, null, NOW), /exitCode: 1/);

  const withoutExit = makeTask({ taskId: "k5", status: "done" });
  assert.doesNotMatch(renderTaskDetail(withoutExit, null, NOW), /exitCode/);
});

test("renderTaskDetail: startedAt/updatedAt 缺失（旧记录容错）→ —", () => {
  const legacy = makeTask({
    taskId: "k6",
    status: "done",
    startedAt: 0,
    updatedAt: 0,
    result: { ...makeTask().result, exitCode: 0 },
  });
  const text = renderTaskDetail(legacy, null, NOW);
  assert.match(text, /startedAt: —/);
  assert.match(text, /updatedAt: —/);
  assert.match(text, /耗时: —/);
});

// ── 边界纯函数 ─────────────────────────────────────────────────────────────

test("durationText: startedAt≤0/非有限数 → —；终态用 updatedAt 口径（future 不回溯）", () => {
  assert.equal(durationText(makeTask({ startedAt: 0 }), NOW), "—");
  assert.equal(durationText(makeTask({ startedAt: Number.NaN }), NOW), "—");
  const done = makeTask({ status: "done", startedAt: 9_000, updatedAt: 9_500 });
  assert.equal(durationText(done, NOW), "500ms"); // 终态忽略 now
});

test("formatNextAttemptAt: 0/缺失 → —；未到点附相对时长；已到点标注", () => {
  assert.equal(formatNextAttemptAt(0, NOW), "—");
  assert.equal(formatNextAttemptAt(Number.NaN, NOW), "—");
  assert.match(formatNextAttemptAt(NOW + 60_000, NOW), /1m0s 后/);
  assert.match(formatNextAttemptAt(NOW - 1000, NOW), /已到点/);
});

test("resumeCommandLine: 空 sessionDir/空 sessionId → null", () => {
  assert.equal(resumeCommandLine("", "id-123"), null);
  assert.equal(resumeCommandLine("/x", null), null);
  assert.equal(resumeCommandLine("/x", ""), null);
});

// ── validateStatusFilter（--status 枚举校验） ──────────────────────────────

test("validateStatusFilter: 7 态全部合法（undefined/空 = 不过滤）", () => {
  for (const status of FARM_STATUS_VALUES) {
    assert.equal(validateStatusFilter(status), null, status);
  }
  assert.equal(validateStatusFilter(undefined), null);
  assert.equal(validateStatusFilter(""), null);
});

test("validateStatusFilter: 枚举外 → 拒绝 + 可选列表", () => {
  const error = validateStatusFilter("flying");
  assert.ok(error !== null);
  assert.match(error, /未知状态 "flying"/);
  assert.match(error, /queued\/running\/timeout\/done\/aborted\/failed\/cancelled/);
});

// ── 装配契约（修复轮）：display 适配层 PaneInfo[] → string[] → farm 探测 ────────

/** 可变时钟（wireFarm now 注入，与 integration-m2 同款口径） */
function mutableClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** 轮询等待（ticker/探测循环驱动场景） */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, pollMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor: 条件 ${timeoutMs}ms 内未满足`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** 测试 owner（"pid+启动时间" 格式，仅字符串消费） */
const SEAM_OWNER = "99999+1700000000000";

/**
 * 装配 seam（真 TaskStore + 真 Queue + 真 wireFarm + 真 adaptListPanes；
 * display/notify/pi 为 fake）。fake display 返回 04 实现真实形状 PaneInfo[]，
 * 经真适配函数（与 index.ts 装配同一来源）接 farm——测试锁定的即真装配路径：
 * listPanes 过 adaptListPanes，其余透传。
 */
function assembleSeam(opts: { root: string; panes: () => PaneInfo[]; now: () => number }): {
  store: TaskStore;
  loop: { start: () => Promise<void>; stop: () => Promise<void> };
  messages: FarmDoneMessage[];
  listCalls: { n: number };
} {
  const store = new TaskStore(opts.root);
  const executor: Executor = {
    async spawn(record) {
      return { paneId: "42", sessionDir: record.result.sessionDir };
    },
    async steer() {
      // M3 占位；队列不调用
    },
    async kill(_paneId: string) {
      // 修复轮同步：Executor.kill 入参已是 paneId（真实现 = display.kill 直传）。
      // seam 的 aborted 路径走 paneGone 注入不触发 killPane，no-op 即可。
    },
  };
  const queue = new Queue({ store, executor, maxConcurrency: 3, now: opts.now, owner: SEAM_OWNER });
  const messages: FarmDoneMessage[] = [];
  const listCalls = { n: 0 };
  const rawDisplay = {
    spawn: async () => "42",
    listPanes: async () => {
      listCalls.n += 1;
      return opts.panes();
    },
    kill: async () => {},
    killSync: () => {},
  };
  const display = {
    spawn: rawDisplay.spawn,
    listPanes: async () => adaptListPanes(await rawDisplay.listPanes()),
    kill: rawDisplay.kill,
    killSync: rawDisplay.killSync,
  };
  const loop = wireFarm({
    queue,
    display,
    pi: { on: () => {} },
    owner: SEAM_OWNER,
    notify: async (message) => {
      messages.push(message);
    },
    farmRoot: opts.root,
    now: opts.now,
    tickIntervalMs: 50,
    probeIntervalMs: 5,
  });
  return { store, loop, messages, listCalls };
}

/** 落盘 running 任务（paneId=42 即 fake display 存活 pane 的 pane_id） */
function seedRunningTask(store: TaskStore, taskId: string, now: number, paneId: string): TaskRecord {
  const task = makeTask({
    taskId,
    owner: SEAM_OWNER,
    status: "running",
    startedAt: now,
    updatedAt: now,
  });
  task.payload.spawn.paneId = paneId;
  return task;
}

test("adaptListPanes（真函数）：pane_id 数值转字符串、缺失/空项剔除", () => {
  assert.deepEqual(
    adaptListPanes([{ pane_id: 42, title: "a" }, { title: "no pane_id" }, { pane_id: 7 }]),
    ["42", "7"],
  );
  assert.deepEqual(adaptListPanes([]), []);
});

test("装配契约：fake display 返回 PaneInfo 对象数组（含 pane_id 缺失项）→ 适配层 → farm 探测不误判 gone（无 aborted 注入/通知）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-seam-"));
  const clock = mutableClock(1_000_000);
  // 04 实现真实形状：listPanes 返回 PaneInfo 对象（直传 farm 会因 diffPanes
  // 只认字符串 → 实际集恒空 → running 全量误判 gone）
  const panes: PaneInfo[] = [
    { pane_id: 42, title: "main session" },
    { title: "entry without pane_id" }, // pane_id 缺失项（版本漂移容错形状）
  ];
  const seam = assembleSeam({ root, panes: () => [...panes], now: clock.now });
  t.after(async () => {
    await seam.loop.stop();
    await rm(root, { recursive: true, force: true });
  });

  const task = seedRunningTask(seam.store, "seam-live", clock.now(), "42");
  await seam.store.writeTask(task);

  await seam.loop.start();
  await waitFor(() => seam.listCalls.n >= 1); // 探测至少跑过一轮（防空过）
  await new Promise((resolve) => setTimeout(resolve, 80)); // 再等 80ms 防迟到误判

  const after = await seam.store.readTask("seam-live");
  assert.equal(after?.status, "running", "存活 pane 不得被注入 aborted");
  assert.equal(seam.messages.length, 0, "不得发出 farm.done 通知");
});

test("装配契约：pane 真消失 → 适配层保留差集探测 → aborted 注入 + farm.done 通知", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-seam-"));
  const clock = mutableClock(1_000_000);
  const panes: PaneInfo[] = [
    { pane_id: 99, title: "another pane" },
    { title: "entry without pane_id" },
  ];
  const seam = assembleSeam({ root, panes: () => [...panes], now: clock.now });
  t.after(async () => {
    await seam.loop.stop();
    await rm(root, { recursive: true, force: true });
  });

  const task = seedRunningTask(seam.store, "seam-gone", clock.now(), "42"); // 42 已消失
  await seam.store.writeTask(task);

  await seam.loop.start();
  await waitFor(() => seam.messages.length >= 1);

  const after = await seam.store.readTask("seam-gone");
  assert.equal(after?.status, "aborted", "真消失 pane 应注入 aborted");
  const text = seam.messages[0]?.text ?? "";
  assert.match(text, /seam-gon/); // buildDoneText taskId 前 8 位口径
  assert.match(text, /中止/);
});
