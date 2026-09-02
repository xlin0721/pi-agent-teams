// src/index.test.ts
// 06 装配票单测：
// 1) farm_status 侧纯渲染（fake tasks 数组：表头/行内容/排序/耗时 startedAt 口径/
//    尾部「活跃/排队 + 任务执行完即可清理」footer（active-only）/空列表）、<taskId> 详情渲染、
//    --status 过滤枚举校验、
//    nextAttemptAt/resumeCommandLine 边界（全部纯函数、零 I/O）。
// 2) 修复轮「装配契约」测试：display 适配层契约（PaneInfo 对象数组 → pane_id
//    字符串）→ farm 探测 seam——真 TaskStore/Queue/wireFarm + 真 adaptListPanes
//    （display/adapt.ts，与 index.ts 装配同一来源）+ fake display/notify，tmp 目录
//    I/O；断言 pane 存活不误判 gone（无 aborted 注入/通知）、pane 真消失仍能差集
//    探测。仍零 pi SDK import（index.ts 的 SDK 装配不在此单测，归 08 smoke）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { selectTasksForCleanup } from "./task-core/cleanup.ts";

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

test("renderFarmTable: 表头 5 列（taskId 前 8 位/role/status/attempts/耗时）+ 尾部「任务执行完即可清理」", () => {
  const text = renderFarmTable([], NOW);
  const lines = text.split("\n");
  assert.equal(lines[0], "taskId   role         status   attempts 耗时");
  assert.match(text, /活跃 0 · 排队 0 · 任务执行完即可清理/);
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

test("renderFarmTable: 耗时 startedAt 口径——未 started → —；running → now-startedAt；timeout（活态非终态）→ now-startedAt", () => {
  const queued = makeTask({ taskId: "q1", status: "queued", startedAt: 0, createdAt: 100 });
  const running = makeTask({ taskId: "r1", status: "running", startedAt: 6_000, updatedAt: 6_000, createdAt: 200 });
  const timeout = makeTask({ taskId: "t1", status: "timeout", startedAt: 7_000, updatedAt: 7_000, createdAt: 300 });
  // active-only（票 04）：done 终态不进面板；done 口径（updatedAt-startedAt）由下面
  // 「durationText: 终态用 updatedAt 口径」用例（L246）直测覆盖。
  const lines = renderFarmTable([queued, running, timeout], NOW).split("\n");
  assert.equal(lines.length, 5); // 表头 + 3 活跃行 + footer
  const qRow = lines[1]!;
  const rRow = lines[2]!;
  const tRow = lines[3]!;
  assert.match(qRow, /—/);
  assert.match(rRow, /4\.0s/);
  assert.match(tRow, /3\.0s/);
  assert.match(tRow, /超时/);
  assert.match(lines[4]!, /活跃 3 · 排队 1 · 任务执行完即可清理/);
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

test("票 05 装配契约（源码序 pin）：executeSpawn 含 sync:true 分支（waiter.wait 先于 ack 返回）+ schema 含 sync/wait_timeout_secs", async () => {
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
  // 1) sync 分支：writeTask 之后、scanTasks(ack) 之前走 waiter.wait
  const syncIdx = src.indexOf("if (params.sync === true && deps.waiter !== undefined");
  const waitIdx = src.indexOf("deps.waiter.wait(taskId");
  const writeIdx = src.indexOf("await deps.store.writeTask(record);");
  const ackIdx = src.indexOf("const all = await deps.store.scanTasks(null);");
  assert.ok(syncIdx > 0 && waitIdx > syncIdx, "sync 分支存在于 writeTask 之后");
  assert.ok(writeIdx < syncIdx && syncIdx < ackIdx, "waiter.wait 在 writeTask 之后、ack 之前");
  // 2) 两处 registerTool schema（main + mini-farm）都含 sync 与 wait_timeout_secs
  const syncCount = src.split("sync: Type.Optional(Type.Boolean").length - 1;
  const waitCount = src.split("wait_timeout_secs: Type.Optional").length - 1;
  assert.equal(syncCount, 2, "main + mini-farm 两处 schema 都含 sync");
  assert.equal(waitCount, 2, "两处 schema 都含 wait_timeout_secs");
});

test("FR8 恒定：registerTool 工具名去重 = 6（farm_cleanup 第 6 工具，票 05）", async () => {
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
  const names = new Set<string>();
  const re = /registerTool\(\{[^}]*?name: "([a-z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.add(m[1]!);
  assert.deepEqual(
    [...names].sort(),
    ["farm_cleanup", "farm_resume", "farm_status", "msg", "spawn_visible_agent", "steer"].sort(),
    "6 工具恒定（FR8）",
  );
});

test("M8 修复：心跳 onUpdate 契约 = 对象 {content:[{type:'text'}]}（非字符串，防 TUI result.content undefined 崩溃）", async () => {
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
  // 1) 适配函数存在且构造对象 content
  assert.match(src, /heartbeatToOnUpdate/, "心跳适配函数存在");
  assert.match(src, /content: \[\{ type: "text", text: message \}\]/, "onUpdate 传对象 content 数组（bash 工具同款契约）");
  // 2) 无字符串直传残留
  assert.ok(!src.includes("onUpdate as (message: string) => void"), "不再把 pi onUpdate 当字符串回调");
});

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

// ── 票 05 farm_cleanup 工具 + 教学 description + 双截断统一 ─────────────────────

/** index.ts 源码读取（源码序 pin 惯例，index.test.ts 严禁 import index.ts）。 */
async function readIndexSrc(): Promise<string> {
  return readFile(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
}

/** farm_cleanup 源码区（代码段 + 注册段）切片：票 05 源码序 pin 用。 */
async function cleanupSrcRegion(tail = 3500): Promise<string> {
  const src = await readIndexSrc();
  const codeStart = src.indexOf("// ── farm_cleanup 工具");
  const regIdx = src.indexOf('name: "farm_cleanup"');
  assert.ok(codeStart > 0 && regIdx > codeStart, "farm_cleanup 代码段与注册段都存在");
  return src.slice(codeStart, regIdx + tail);
}

test("票 05 注册序：farm_cleanup 紧接 farm_status 后、mini-farm 分支前（main+depth-1 共享路径）", async () => {
  const src = await readIndexSrc();
  const statusIdx = src.indexOf('name: "farm_status"');
  const cleanupIdx = src.indexOf('name: "farm_cleanup"');
  const miniIdx = src.indexOf("assembleMiniFarm(pi, { display, store, agentRoles, inbox });");
  assert.ok(statusIdx > 0 && cleanupIdx > statusIdx, "farm_cleanup 注册在 farm_status 之后");
  assert.ok(
    cleanupIdx < miniIdx,
    "farm_cleanup 在 depth-1 mini-farm 分支之前（共享路径，main + depth-1 都注册）",
  );
});

test("票 05 schema：confirm（Boolean，缺省 false=dry-run）+ status（String 逗号分隔真终态子集）", async () => {
  const src = await readIndexSrc();
  const regIdx = src.indexOf('name: "farm_cleanup"');
  const region = src.slice(regIdx, regIdx + 1800);
  assert.match(region, /confirm: Type\.Optional\(Type\.Boolean/);
  assert.match(region, /status: Type\.Optional\(\s*Type\.String/);
  assert.match(region, /逗号分隔的真终态子集/);
  assert.match(region, /缺省 = done,cancelled,failed/);
  assert.match(region, /aborted 默认排除、显式点名才清/);
});

test("票 05 description 教学 2 必含 + promptGuidelines（任务一次性即清 / 先报告再 confirm；aborted 唯一例外）", async () => {
  const src = await readIndexSrc();
  const regIdx = src.indexOf('name: "farm_cleanup"');
  const region = src.slice(regIdx, regIdx + 2600);
  // 教学 ①：任务一次性——执行完毕（结果通知已收到）即可随时清理，不必等用户要求；aborted 唯一例外
  assert.match(region, /任务一次性——执行完毕（结果通知已收到）即可随时清理，不必等用户要求/);
  assert.match(region, /aborted 是唯一例外（可 farm_resume 恢复），默认不碰、显式 --status aborted 点名才清/);
  // 教学 ②：永远先跑报告（默认 dry-run），读 skipped 分组（未通知是正常非 bug）再 --confirm
  assert.match(region, /永远先跑报告（默认 dry-run，不删除），读 skipped 分组（未通知是正常非 bug）再 --confirm 执行/);
  // promptGuidelines 草案要点
  assert.match(region, /批量 spawn 完成后顺手清理/);
  assert.match(region, /费用减少透明汇报：--confirm 前后对照合计/);
  assert.match(region, /清理后可用 farm_status 闭环验证/);
  assert.match(region, /per-workspace 边界：depth-1 角色 agent 可清理 main 层任务/);
  assert.match(region, /与自动 GC 双轨：主动清理更快，GC 24h 兜底/);
  assert.match(region, /清理≠取消任务：queued\/running\/timeout 非终态一律拒绝/);
});

test("票 05 farm_status 教学链第一环：sessions 3 days + 终态可随时 farm_cleanup 清理", async () => {
  const src = await readIndexSrc();
  const statusIdx = src.indexOf('name: "farm_status"');
  const cleanupIdx = src.indexOf('name: "farm_cleanup"');
  const region = src.slice(statusIdx, cleanupIdx);
  assert.match(region, /sessions are kept 3 days/);
  assert.match(region, /终态任务可随时用 farm_cleanup 清理/);
  assert.match(region, /Finished tasks can be cleaned up anytime with farm_cleanup/);
});

test("票 05 拒绝路径：非终态（queued/running/timeout）与未知 status → ❌ 拒绝（白名单仅真终态四态）", async () => {
  const region = await cleanupSrcRegion();
  assert.match(region, /只接受真终态 \$\{CLEANUP_STATUSES\.join\("\/"\)\}（逗号分隔）/);
  assert.match(region, /queued\/running\/timeout 非终态不可清理（timeout 可能自动复活重试）/);
  // 白名单常量 pin：真终态四态；缺省集不含 aborted（默认排除）
  assert.match(region, /CLEANUP_STATUSES = \["done", "cancelled", "failed", "aborted"\]/);
  assert.match(region, /DEFAULT_CLEANUP_STATUSES: ReadonlySet<TaskStatus> = new Set\(\["done", "cancelled", "failed"\]\)/);
});

test("票 05 aborted 缺省排除 + 显式点名才清（selectTasksForCleanup 白名单行为级）", () => {
  const now = NOW;
  const abortedNotified = makeTask({
    taskId: "ab1",
    status: "aborted",
    notifiedAt: now,
    updatedAt: now - 1000,
    attempts: 1,
    maxAttempts: 2,
  });
  const abortedUnnotified = makeTask({
    taskId: "ab2",
    status: "aborted",
    notifiedAt: 0,
    updatedAt: now - 1000,
    attempts: 1,
    maxAttempts: 2,
  });
  const done = makeTask({ taskId: "do1", status: "done", notifiedAt: now, updatedAt: now - 1000 });
  // 缺省集 {done, cancelled, failed}（index.ts 显式传 DEFAULT_CLEANUP_STATUSES）：aborted 不入 deletable
  const sel = selectTasksForCleanup([abortedNotified, abortedUnnotified, done], now, {
    replayWindowMs: 24 * 3600 * 1000,
    statuses: new Set(["done", "cancelled", "failed"]),
  });
  assert.equal(sel.deletable.length, 1);
  assert.equal(sel.deletable[0]!.taskId, "do1");
  // 显式点名 aborted：已通知可清；未通知仍被通知守卫挡住（skipped.unnotified）
  const named = selectTasksForCleanup([abortedNotified, abortedUnnotified], now, {
    replayWindowMs: 24 * 3600 * 1000,
    statuses: new Set(["done", "cancelled", "failed", "aborted"]),
  });
  assert.equal(named.deletable.length, 1);
  assert.equal(named.deletable[0]!.taskId, "ab1");
  assert.equal(named.skipped.unnotified.length, 1);
  assert.equal(named.skipped.unnotified[0]!.taskId, "ab2");
});

test("票 05 复查式删除（真 TaskStore 行为级）：已通知 done 可删；未通知 skipped；已复活（failed 可重试）not-terminal；已删再删 missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-cleanup-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const store = new TaskStore(root);
  const now = Date.now();
  const doneNotified = makeTask({ taskId: "del-ok", status: "done", notifiedAt: now, updatedAt: now - 1000 });
  const doneUnnotified = makeTask({ taskId: "del-un", status: "done", notifiedAt: 0, updatedAt: now - 1000 });
  const live = makeTask({ taskId: "del-live", status: "running" });
  const revived = makeTask({ taskId: "del-rev", status: "failed", notifiedAt: now, attempts: 1, maxAttempts: 2 });
  for (const task of [doneNotified, doneUnnotified, live, revived]) await store.writeTask(task);

  assert.deepEqual(await store.deleteTask("del-ok"), { deleted: true });
  assert.deepEqual(await store.deleteTask("del-un"), { deleted: false, reason: "unnotified" });
  assert.deepEqual(await store.deleteTask("del-live"), { deleted: false, reason: "not-terminal" });
  assert.deepEqual(await store.deleteTask("del-rev"), { deleted: false, reason: "not-terminal" });
  assert.deepEqual(await store.deleteTask("del-ok"), { deleted: false, reason: "missing" });
});

test("票 05 费用影响与四类文案（✅❌⏳⚠️）+ aborted 侧成本注记 + 空态", async () => {
  const region = await cleanupSrcRegion();
  // 费用口径：仅计 result.cost，aborted 侧成本不计入；占位价注记
  assert.match(region, /仅计 result\.cost，aborted 侧成本不计入/);
  assert.match(region, /⚠️ 成本为占位价：请编辑 ~\/\.pi-agent-teams\/pricing\.json 校准/);
  // 四类文案锚点
  assert.match(region, /✅ 已清理 \$\{deleted\} 个任务/);
  assert.match(region, /⏳ farm_cleanup 报告（dry-run，未删除任何任务）/);
  assert.match(region, /❌ 非法 status/);
  assert.match(region, /⚠️ \$\{failed\} 个删除失败（已跳过）/);
  // 空态：无可清理（真终态且已通知才可清；aborted 默认保留）
  assert.match(region, /无可清理（真终态且已通知才可清；aborted 默认保留）/);
});

test("票 05 双截断统一：613 executeFarmStatus 与 1076 refreshPanel 均走 splitTasksForDisplay（读盘上界 ≤150）", async () => {
  const src = await readIndexSrc();
  // 613：executeFarmStatus 本地 renderFarmToolTable（弃用 probe.renderFarmTable 调用）
  assert.ok(!src.includes("renderFarmTable("), "index.ts 不再调用 renderFarmTable（probe 保留不动）");
  assert.match(src, /renderFarmToolTable\(filtered, now\)/);
  assert.match(src, /splitTasksForDisplay\(filtered, PANEL_RECENT_N\)/);
  // 活跃硬顶 PANEL_MAX_ROWS 折叠
  assert.match(src, /activeSorted\.slice\(0, PANEL_MAX_ROWS\)/);
  // 1076：refreshPanel shown 集 = 活跃硬顶 + 最近终态（读盘上界 ≤ 100 + 50 = 150，BE#5 保持）
  assert.match(src, /splitTasksForDisplay\(tasks, PANEL_RECENT_N\)/);
  assert.match(src, /const shown = \[\.\.\.active\.slice\(0, PANEL_MAX_ROWS\), \.\.\.recent\];/);
  // PANEL_RECENT_N 保留 = recent 上界
  assert.match(src, /const PANEL_RECENT_N = 50/);
});

test("票 05 grep 白名单负向：index.ts 零匹配 7 天/7d/7 days（会话保留口径 7→3 天）", async () => {
  const src = await readIndexSrc();
  assert.doesNotMatch(src, /7\s?天|7\s?d|7 days/i, "index.ts 无 7 天/7d/7 days 残留");
  // 正向锚点：3 天口径就位（farm_status description / farm_resume description / L19 注释）
  assert.match(src, /sessions are kept 3 days/);
  assert.match(src, /≤3d session GC window/);
  assert.match(src, />3d\), resume reports/);
  assert.match(src, /GC 3d 口径/);
});

test("票 05 farm_resume 已删任务友好文案（🟡48 R6）：readTask→null 预检返回「可能已被 farm_cleanup 清理」", async () => {
  const src = await readIndexSrc();
  const resumeIdx = src.indexOf("function registerResumeTool");
  const region = src.slice(resumeIdx, resumeIdx + 2200);
  assert.match(region, /const record = await store\.readTask\(resumeParams\.taskId\);/);
  assert.match(region, /可能已被 farm_cleanup 清理（终态任务清理后不可恢复；aborted 默认保留，可 resume）/);
  assert.ok(region.indexOf("executeResume(resumeParams") > region.indexOf("record === null"), "预检在 executeResume 之前");
});
