// src/task-core/integration.test.ts
// M1b task-core 独立集成测试（e2e-tester）：
// 用公共 API（TaskStore / Queue / Inbox / buildResumeArgs / parseSessionId /
// parseSchedule / nextFire）串起端到端语义链，只断言外部行为——
// 磁盘文件效果、返回值、fake Executor 调用、通知序列。不 mock 内部函数。
// 接缝：TaskStore 根目录注入（fs.mkdtemp）+ fake Executor（可编程写 pane 信号）+
// 可变时钟（无真实定时器）。零依赖：仅 node: 内置模块；相对导入带 .ts 扩展。

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "./store.ts";
import type { TaskRecord } from "./store.ts";
import { Queue } from "./queue.ts";
import type { Executor } from "./queue.ts";
import { Inbox, pickLatest } from "./steer.ts";
import type { InboxMessage } from "./steer.ts";
import { buildResumeArgs, parseSessionId } from "./resume.ts";
import { nextFire, parseSchedule } from "./schedule.ts";
import type { CronSchedule } from "./schedule.ts";

// ---------- 测试接缝 ----------

/** fake Executor：记录 spawn/kill 调用；onSpawn 钩子模拟 pane 侧扩展写 status 信号。 */
class FakeExecutor implements Executor {
  spawnCalls: TaskRecord[] = [];
  killCalls: string[] = [];
  onSpawn: ((task: TaskRecord) => Promise<void> | void) | null = null;

  async spawn(task: TaskRecord): Promise<{ paneId: string; sessionDir: string }> {
    this.spawnCalls.push(task);
    if (this.onSpawn !== null) await this.onSpawn(task);
    // 返回体形状与 M1b 兼容 fake 同口径（空 paneId/sessionDir：Queue.spawnAttempt
    // 容错分支回退用 record.result.sessionDir，行为与旧 undefined 返回一致）
    return { paneId: "", sessionDir: "" };
  }
  async steer(_taskId: string, _content: string): Promise<void> {}
  async kill(taskId: string): Promise<void> {
    this.killCalls.push(taskId);
  }
}

/** §13.3 全字段 task record（默认 queued；顶层字段可覆盖）。 */
function fullRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t-default",
    type: "spawn",
    parentId: null,
    depth: 0,
    status: "queued",
    owner: "pid+start",
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    startedAt: 0,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs: 300,
    attempts: 0,
    maxAttempts: 2,
    backoffSecs: [5, 30],
    payload: {
      spawn: { form: "tui", role: "tech-director", prompt: "do it", cwd: "/tmp/p1", resumeFrom: null, paneId: "" },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: [], delivery: "notice", content: "" },
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

/** 模拟 pane 侧扩展写 status/<taskId>.done（JSON {exitCode, sessionDir}）。 */
async function writeDoneSignal(
  root: string,
  taskId: string,
  exitCode: number,
  sessionDir: string,
): Promise<void> {
  const dir = join(root, "status");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${taskId}.done`),
    JSON.stringify({ exitCode, sessionDir }),
    { mode: 0o600 },
  );
}

/** 独立 oracle：按文档契约（本地时间、分钟粒度）暴力扫描下一个 cron 命中。 */
function bruteNextFire(s: CronSchedule, fromMs: number): number | null {
  let minute = Math.floor(fromMs / 60_000) + 1;
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const ms = minute * 60_000;
    const d = new Date(ms);
    if (s.hours.has(d.getHours()) && s.minutes.has(d.getMinutes())) return ms;
    minute += 1;
  }
  return null;
}

// ---------- 场景 1：派发 → 出队 → pane done → 完成通知链 ----------

test("integration: 派发→出队→pane done→result 落盘（spawn 收 running 全字段 record）", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-it-"));
  const store = new TaskStore(root);
  const executor = new FakeExecutor();
  const clock = { now: 1_000_000 };
  const queue = new Queue({ store, executor, now: () => clock.now });
  try {
    const record = fullRecord({
      taskId: "t-dispatch",
      payload: {
        ...fullRecord().payload,
        spawn: { form: "tui", role: "tech-director", prompt: "write tests", cwd: "/tmp/p1", resumeFrom: null, paneId: "" },
      },
    });
    // 1) 派发：派发方写 task 文件（queued）
    await store.writeTask(record);
    assert.equal((await store.readTask("t-dispatch"))?.status, "queued");

    // 2) 出队：Queue.step 分配并发位并 spawn
    const r1 = await queue.step();
    assert.deepEqual(
      r1.decisions.map((d) => d.event),
      ["dequeue"],
    );
    assert.equal(executor.spawnCalls.length, 1);
    assert.equal(executor.spawnCalls[0].status, "running"); // spawn 收完整落盘 record
    assert.equal((await store.readTask("t-dispatch"))?.status, "running");

    // 3) pane done：pane 侧扩展写 status 信号（M2 真实现；本测试模拟）
    await writeDoneSignal(root, "t-dispatch", 0, "/tmp/sessions/sess-1");

    // 4) 下一步：done + result 落盘
    const r2 = await queue.step();
    assert.deepEqual(
      r2.decisions.map((d) => d.event),
      ["paneDone"],
    );
    const done = await store.readTask("t-dispatch");
    assert.equal(done?.status, "done");
    assert.equal(done?.result.exitCode, 0);
    assert.equal(done?.result.sessionDir, "/tmp/sessions/sess-1");

    // 5) 终态封闭：再 step 无新决策、无重复 spawn、无通知
    const r3 = await queue.step();
    assert.equal(r3.decisions.length, 0);
    assert.equal(r3.notifications.length, 0);
    assert.equal(executor.spawnCalls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------- 场景 2：超时 → 重试 → 再超时 → 用尽（deadline 路径三刷） ----------

test("integration: deadline 三刷——timeout→retry→…→exhausted，attempts/退避/终态通知单发", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-it-"));
  const store = new TaskStore(root);
  const executor = new FakeExecutor();
  const clock = { now: 1_000_000 };
  const queue = new Queue({ store, executor, now: () => clock.now });
  const t0 = clock.now;
  const TIMEOUT = 10_000; // timeoutSecs=10
  const allNotifications: { taskId: string; reason: string }[] = [];
  try {
    const record = fullRecord({
      taskId: "t-retry",
      timeoutSecs: 10,
      attempts: 0,
      maxAttempts: 2,
      backoffSecs: [5, 30],
    });
    await store.writeTask(record);

    const step = async (): Promise<void> => {
      const report = await queue.step();
      allNotifications.push(...report.notifications);
    };

    // 刷 1：dequeue → deadline → retry（attempts 1，退避 5s）
    await step();
    assert.equal(executor.spawnCalls.length, 1);
    clock.now = t0 + TIMEOUT;
    await step(); // deadline → timeout
    assert.equal((await store.readTask("t-retry"))?.status, "timeout");
    await step(); // retry → queued，attempts=1
    const afterR1 = await store.readTask("t-retry");
    assert.equal(afterR1?.status, "queued");
    assert.equal(afterR1?.attempts, 1);

    // 退避窗口内（nextAttemptAt-1ms）不出队；到点（+5s）出队 → spawn 2
    clock.now = t0 + TIMEOUT + 5_000 - 1;
    await step();
    assert.equal(executor.spawnCalls.length, 1); // 退避未到点，不 spawn
    clock.now = t0 + TIMEOUT + 5_000;
    await step();
    assert.equal(executor.spawnCalls.length, 2);

    // 刷 2：再超时 → retry（attempts 2，退避 30s）
    clock.now = t0 + 2 * TIMEOUT + 5_000;
    await step(); // deadline
    assert.equal((await store.readTask("t-retry"))?.status, "timeout");
    await step(); // retry → queued，attempts=2
    const afterR2 = await store.readTask("t-retry");
    assert.equal(afterR2?.status, "queued");
    assert.equal(afterR2?.attempts, 2);

    clock.now = t0 + 2 * TIMEOUT + 5_000 + 30_000 - 1;
    await step();
    assert.equal(executor.spawnCalls.length, 2); // 30s 退避未到点
    clock.now = t0 + 2 * TIMEOUT + 5_000 + 30_000;
    await step();
    assert.equal(executor.spawnCalls.length, 3);

    // 刷 3：再超时 → attempts 用尽 → exhausted → failed（终态通知恰好一次）
    clock.now = t0 + 3 * TIMEOUT + 5_000 + 30_000;
    await step(); // deadline
    const timedOut = await store.readTask("t-retry");
    assert.equal(timedOut?.status, "timeout");
    assert.equal(timedOut?.attempts, 2);
    await step(); // exhausted → failed + notifyMain
    const final = await store.readTask("t-retry");
    assert.equal(final?.status, "failed");
    assert.equal(final?.attempts, 2);

    // 终态后继续 step：无新决策、无重复通知、无新 spawn
    await step();
    await step();
    assert.equal(executor.spawnCalls.length, 3);
    const exhausted = allNotifications.filter((n) => n.reason === "attemptsExhausted");
    assert.equal(exhausted.length, 1); // 通知只发一次
    assert.equal(exhausted[0].taskId, "t-retry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------- 场景 3：仲裁（同 tick pane done 信号 + deadline 双达 → done 胜） ----------

test("integration: 仲裁——同一 tick done 信号与 deadline 同时到达，pane 信号优先", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-it-"));
  const store = new TaskStore(root);
  const executor = new FakeExecutor();
  const clock = { now: 1_000_000 };
  const queue = new Queue({ store, executor, now: () => clock.now });
  try {
    const record = fullRecord({ taskId: "t-arb", timeoutSecs: 10 });
    await store.writeTask(record);

    await queue.step(); // dequeue → running（updatedAt = t0）
    assert.equal(executor.spawnCalls.length, 1);

    // deadline 前 pane 已写完 done 信号；tick 时 deadline 也已到期（双条件同达）
    clock.now += 5_000;
    await writeDoneSignal(root, "t-arb", 0, "/tmp/sessions/arb-sess");
    clock.now += 5_000; // now = t0 + 10_000 = deadline 时刻

    const report = await queue.step();
    assert.deepEqual(
      report.decisions.map((d) => d.event),
      ["paneDone"], // 不是 deadline
    );
    const done = await store.readTask("t-arb");
    assert.equal(done?.status, "done");
    assert.equal(done?.result.exitCode, 0);
    assert.equal(done?.result.sessionDir, "/tmp/sessions/arb-sess");
    assert.equal(report.notifications.length, 0);
    assert.equal(executor.spawnCalls.length, 1); // 无误杀/无重复 spawn
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------- 场景 4：steer 集成（deliver → pickLatest → advance） ----------

test("integration: steer 链路——多条投递 latest-wins，投递态 pending→delivered→read 单向推进", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-it-"));
  const inbox = new Inbox(root);
  try {
    const inputs = ["go", "wait", "stop now"].map((content) => ({
      type: "steer" as const,
      from: "main",
      to: "pane-1",
      delivery: "directive" as const,
      content,
    }));
    const m1 = await inbox.deliver(inputs[0]);
    const m2 = await inbox.deliver(inputs[1]);
    const m3 = await inbox.deliver(inputs[2]);

    // nonce 单调（ts 兼任）：后投递的 ts 不小于先投递的
    assert.ok(m3.ts >= m2.ts && m2.ts >= m1.ts);

    // pickLatest：乱序输入也取最新（ts 最大）
    assert.equal(pickLatest([m2, m1, m3])?.msgId, m3.msgId);
    assert.equal(pickLatest([m1, m2, m3])?.content, "stop now");

    // 投递态单向推进：pending → delivered → read，磁盘文件同步落盘
    const delivered = await inbox.advance(m3.msgId, "pane-1", "delivered");
    assert.equal(delivered.status, "delivered");
    let onDisk = JSON.parse(
      await readFile(join(root, "inbox", "pane-1", `${m3.msgId}.json`), "utf8"),
    ) as InboxMessage;
    assert.equal(onDisk.status, "delivered");

    const read = await inbox.advance(m3.msgId, "pane-1", "read");
    assert.equal(read.status, "read");
    onDisk = JSON.parse(
      await readFile(join(root, "inbox", "pane-1", `${m3.msgId}.json`), "utf8"),
    ) as InboxMessage;
    assert.equal(onDisk.status, "read");
    assert.equal(onDisk.content, "stop now"); // 其余字段原样保留

    // latest-wins 不因投递态推进改变（ts 未变）
    assert.equal(pickLatest([m1, m2, m3])?.msgId, m3.msgId);

    // 回退（read → delivered）被拒绝
    await assert.rejects(
      inbox.advance(m3.msgId, "pane-1", "delivered"),
      /illegal status advance/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------- 场景 5：恢复集成（buildResumeArgs × parseSessionId 回读自洽） ----------

test("integration: 恢复链路——真实形态 jsonl 文件名解析 session id，命令形态逐字匹配", async () => {
  const sessionId = randomUUID();
  // 真实形态：<ISO时间戳>_<uuid>.jsonl（pi 会话文件命名）
  const filename = `2026-08-13T03-07-59-550Z_${sessionId}.jsonl`;

  const parsed = parseSessionId(filename);
  assert.equal(parsed, sessionId);

  // 命令形态必须逐字为 -p --session-dir <dir> --session <id>（FR4 权威形态）
  const sessionDir = "/tmp/pi-agent-teams/sessions";
  const args = buildResumeArgs(sessionDir, parsed as string);
  assert.deepEqual(args, ["-p", "--session-dir", sessionDir, "--session", sessionId]);

  // 回读自洽：args 中的 id 重新拼文件名 → 解析回同一 id
  const idFromArgs = args[args.indexOf("--session") + 1];
  assert.equal(parseSessionId(`2026-08-13T03-07-59-550Z_${idFromArgs}.jsonl`), sessionId);

  // 非 jsonl 形态拒绝（不误认）
  assert.equal(parseSessionId(`2026-08-13T03-07-59-550Z_${sessionId}.json`), null);
});

// ---------- 场景 6：调度集成（parseSchedule → nextFire） ----------

test("integration: 调度链路——cron 解析产物驱动 nextFire，严格未来且命中集合内", async () => {
  const s = parseSchedule({ mode: "cron", cron: "*/15 9-17 * * *" });
  assert.equal(s.kind, "cron");
  if (s.kind !== "cron") return;
  assert.deepEqual([...s.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual(
    [...s.hours].sort((a, b) => a - b),
    [9, 10, 11, 12, 13, 14, 15, 16, 17],
  );

  // 业务时间之外（凌晨 03:07:59.550）起算：nextFire 严格未来、分钟边界、命中集合
  const from = new Date(2026, 7, 13, 3, 7, 59, 550).getTime(); // 本地时间
  const next = nextFire(s, from);
  assert.ok(next > from, "nextFire 必须严格大于 from");
  assert.equal(next % 60_000, 0, "分钟粒度：命中必在分钟边界");
  const hit = new Date(next);
  assert.ok(s.hours.has(hit.getHours()) && s.minutes.has(hit.getMinutes()));

  // 与独立 oracle（契约暴力扫描）一致：nextFire 返回第一个命中
  assert.equal(next, bruteNextFire(s, from));

  // 边界：from 恰在命中分钟上 → 取下一个命中（不返回 from 本身）
  const atHit = new Date(2026, 7, 13, 9, 15, 0, 0).getTime();
  const nextAfterHit = nextFire(s, atHit);
  assert.ok(nextAfterHit > atHit);
  assert.equal(nextAfterHit, bruteNextFire(s, atHit));
});
