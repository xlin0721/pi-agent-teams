// src/comm/feed.test.ts
// buildFeed 纯渲染用例（票 01 plan §5.3 清单全覆盖；票 04：active-only shown 源 + 行
// 硬顶 100 + 折叠、recentN 废弃 no-op、presence 不再入 footer、合计口径静态注记）。
// 只断言输出行文本（表头/5 列宽对齐/usage/投递态/截断/active-only/折叠/footer），零 I/O。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFeed } from "./feed.ts";
import type { UsageSidecar } from "../task-core/queue.ts";
import { renderFarmTable } from "../probe.ts";
import type { TaskRecord } from "../task-core/store.ts";
import type { TaskStatus } from "../task-core/states.ts";
import type { InboxMessage } from "../task-core/steer.ts";
import type { PricingTable } from "../pricing.ts";

const NOW = 5_000;

function makeTask(over: {
  taskId?: string;
  status?: TaskStatus;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  attempts?: number;
  maxAttempts?: number;
  role?: string;
  paneId?: string;
} = {}): TaskRecord {
  return {
    taskId: over.taskId ?? "task-00000001",
    type: "spawn",
    parentId: null,
    depth: 1,
    status: over.status ?? "running",
    owner: "main",
    createdAt: over.createdAt ?? 1_000,
    updatedAt: over.updatedAt ?? 1_000,
    startedAt: over.startedAt ?? 1_000,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs: 0,
    attempts: over.attempts ?? 1,
    maxAttempts: over.maxAttempts ?? 3,
    backoffSecs: [],
    payload: {
      spawn: {
        role: over.role ?? "planner",
        prompt: "",
        cwd: "",
        resumeFrom: null,
        paneId: over.paneId ?? "",
      },
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
  };
}

function inboxMsg(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    msgId: "m",
    type: "steer",
    from: "main",
    to: "pane-1",
    delivery: "directive",
    content: "",
    status: "pending",
    ts: 1,
    ...over,
  };
}

test("空 tasks：只有表头 + footer（活跃 0 · 排队 0 + 即清 + 合计口径注记）", () => {
  const feed = buildFeed([], [], [], new Map(), { now: NOW });
  assert.deepEqual(feed, [
    "taskId   role         status   attempts 耗时 usage/费用 投递",
    "活跃 0 · 排队 0 · 任务执行完即可清理 · 合计=保留期内列表费用（历史不累计）",
  ]);
});

test("满列表：行序 createdAt 升序、5 列宽与 renderFarmTable 逐字对齐", () => {
  const t3 = makeTask({ taskId: "t3", createdAt: 3, startedAt: 1_000 });
  const t1 = makeTask({ taskId: "t1", createdAt: 1, startedAt: 1_000 });
  const t2 = makeTask({ taskId: "t2", createdAt: 2, startedAt: 1_000 });

  const feed = buildFeed([t3, t1, t2], [], [], new Map(), { now: NOW });

  // 表头 = renderFarmTable 表头 + usage/投递两列
  assert.equal(feed[0], renderFarmTable([], NOW).split("\n")[0] + " usage/费用 投递");
  // 行序 createdAt 升序
  const order = feed.slice(1, -1).map((line) => line.slice(0, 8).trim());
  assert.deepEqual(order, ["t1", "t2", "t3"]);
  // 每行前 5 列与 renderFarmTable 逐字一致（无 usage/paneId → "— —" 后缀）
  assert.equal(feed[1], renderFarmTable([t1], NOW).split("\n")[1] + " — —");
  assert.equal(feed[2], renderFarmTable([t2], NOW).split("\n")[1] + " — —");
  assert.equal(feed[3], renderFarmTable([t3], NOW).split("\n")[1] + " — —");
});

test("usage 列：有 sidecar → ↑in ↓out；缺 sidecar → —", () => {
  const withUsage = makeTask({ taskId: "a-with-usage", createdAt: 1 });
  const noUsage = makeTask({ taskId: "b-no-usage", createdAt: 2 });
  const usage: UsageSidecar = { model: "gpt", inputTokens: 100, outputTokens: 200, updatedAt: NOW };
  const feed = buildFeed([noUsage, withUsage], [], [], new Map([["a-with-usage", usage]]), { now: NOW });

  assert.ok(feed[1].includes("↑100 ↓200"));
  assert.ok(feed[2].includes("— —")); // 无 usage、无投递态
});

test("投递态三态：pending/delivered/read 各自格式；无 inbox 消息 → —", () => {
  const task = makeTask({ taskId: "t1", paneId: "pane-1" });
  const statuses = ["pending", "delivered", "read"] as const;
  for (const status of statuses) {
    const snapshot = [inboxMsg({ status, ts: 1 })];
    const feed = buildFeed([task], [], snapshot, new Map(), { now: NOW });
    assert.ok(feed[1].includes(`steer:${status} @main`), `期望含 steer:${status} @main，实际 ${feed[1]}`);
  }

  // 无 inbox 消息（空 snapshot）→ 投递态列 —
  const feedNone = buildFeed([task], [], [], new Map(), { now: NOW });
  assert.ok(feedNone[1].includes("— —"));
});

test("窄宽截断（FE#4）：长 usage/投递态右向截断加 …，前 5 列不折行", () => {
  const task = makeTask({ taskId: "t1", paneId: "pane-1" });
  const usage: UsageSidecar = {
    model: "very-long-model-name",
    inputTokens: 123456789,
    outputTokens: 987654321,
    updatedAt: NOW,
  };
  const snapshot = [
    inboxMsg({ status: "delivered", from: "a-very-long-sender-name", ts: 1 }),
  ];
  const five = renderFarmTable([task], NOW).split("\n")[1];

  const feed = buildFeed([task], [], snapshot, new Map([["t1", usage]]), {
    now: NOW,
    maxWidth: 60,
  });

  const row = feed[1];
  assert.ok(row.length <= 60, `行宽 ${row.length} 应 ≤ 60`);
  assert.ok(row.endsWith("…"), `应右向截断加省略号，实际 ${row}`);
  assert.ok(row.startsWith(five + " "), "前 5 列不折行");
});

test("recentN 废弃 no-op（票 04）：传 recentN 不截断，全部活跃行渲染 + 无「显示最近」段", () => {
  const tasks = [1, 2, 3, 4, 5].map((i) => makeTask({ taskId: `t${i}`, createdAt: i }));
  const feed = buildFeed(tasks, [], [], new Map(), { now: NOW, recentN: 2 });

  assert.equal(feed.length, 7); // 表头 + 5 活跃行 + footer
  const order = feed.slice(1, -1).map((line) => line.slice(0, 8).trim());
  assert.deepEqual(order, ["t1", "t2", "t3", "t4", "t5"]); // 全部活跃渲染（缺省 status=running）
  assert.equal(feed[6], "活跃 5 · 排队 0 · 任务执行完即可清理 · 合计=保留期内列表费用（历史不累计）");
});

test("硬顶 PANEL_MAX_ROWS=100（票 04）：120 活跃缺省折叠为 100 行 +「另有 20 条排队」+ footer", () => {
  const tasks = Array.from({ length: 120 }, (_, i) =>
    makeTask({ taskId: `t${String(i + 1).padStart(3, "0")}`, createdAt: i + 1 }),
  );
  const feed = buildFeed(tasks, [], [], new Map(), { now: NOW });

  assert.equal(feed.length, 103); // 表头 + 100 行 + 折叠行 + footer
  const order = feed.slice(1, 101).map((line) => line.slice(0, 8).trim());
  assert.equal(order.length, 100);
  assert.equal(feed[101], "另有 20 条排队");
  assert.equal(feed[102], "活跃 120 · 排队 0 · 任务执行完即可清理 · 合计=保留期内列表费用（历史不累计）");
});

test("recentN<=0（票 04 废弃 no-op 同款）：recentN 忽略，全部活跃渲染", () => {
  const tasks = [1, 2, 3].map((i) => makeTask({ taskId: `t${i}`, createdAt: i }));
  const feed = buildFeed(tasks, [], [], new Map(), { now: NOW, recentN: 0 });
  assert.equal(feed.length, 5); // 表头 + 3 行 + footer
  assert.equal(feed[4], "活跃 3 · 排队 0 · 任务执行完即可清理 · 合计=保留期内列表费用（历史不累计）");
});

test("presence 不再入 footer（票 04 签名兼容）：存活计数不出现，输出不受 presence 影响", () => {
  const alive = { taskId: "t1", paneId: "p1", role: "r", depth: 1, pid: 1, heartbeatAt: NOW };
  const expired = { taskId: "t2", paneId: "p2", role: "r", depth: 1, pid: 2, heartbeatAt: NOW - 20_000 };
  const feed = buildFeed([], [alive, expired], [], new Map(), { now: NOW });
  assert.equal(feed[1], "活跃 0 · 排队 0 · 任务执行完即可清理 · 合计=保留期内列表费用（历史不累计）");
});

// ── 票 05：成本列（定价经注入 PricingTable 行为断言） ─────────────────────────

const TEST_PRICING: PricingTable = {
  currency: "USD",
  per: 1_000_000,
  models: {
    "model-a": { input: 1.0, output: 2.0 },
    "model-b": { input: 10.0, output: 20.0 },
  },
};

function withCost(
  task: TaskRecord,
  cost: { model: string; inputTokens: number; outputTokens: number },
): TaskRecord {
  task.result.cost = cost;
  return task;
}

test("成本列：已知模型 sidecar → ↑N ↓N $X.XXXX（注入定价）", () => {
  const task = makeTask({ taskId: "t1", createdAt: 1 });
  const usage: UsageSidecar = { model: "model-a", inputTokens: 1_000_000, outputTokens: 0, updatedAt: NOW };
  const feed = buildFeed([task], [], [], new Map([["t1", usage]]), { now: NOW, pricing: TEST_PRICING });
  assert.ok(feed[1].includes("↑1000000 ↓0 $1.0000"), feed[1]);
});

test("成本列：running 无数据（无 sidecar、result.cost 空）→ —", () => {
  const task = makeTask({ taskId: "t1", status: "running", createdAt: 1 });
  const feed = buildFeed([task], [], [], new Map(), { now: NOW, pricing: TEST_PRICING });
  assert.ok(feed[1].includes("— —"), feed[1]); // usage — + 投递 —
});

test("成本列：未知模型 → ↑N ↓N —", () => {
  const task = makeTask({ taskId: "t1", createdAt: 1 });
  const usage: UsageSidecar = { model: "unknown-model", inputTokens: 100, outputTokens: 200, updatedAt: NOW };
  const feed = buildFeed([task], [], [], new Map([["t1", usage]]), { now: NOW, pricing: TEST_PRICING });
  assert.ok(feed[1].includes("↑100 ↓200 —"), feed[1]);
});

test("costSourceFor：sidecar 优先于 result.cost（active-only 下用 running 承载 same 语义）", () => {
  const task = withCost(makeTask({ taskId: "t1", createdAt: 1 }), {
    model: "model-b",
    inputTokens: 1_000_000,
    outputTokens: 0,
  });
  const usage: UsageSidecar = { model: "model-a", inputTokens: 1_000_000, outputTokens: 0, updatedAt: NOW };
  const feed = buildFeed([task], [], [], new Map([["t1", usage]]), { now: NOW, pricing: TEST_PRICING });
  assert.ok(feed[1].includes("$1.0000"), feed[1]);
  assert.ok(!feed[1].includes("$10.0000"), feed[1]);
});

test("costSourceFor：无 sidecar → result.cost 兜底（active-only 下用 running 承载 same 语义）", () => {
  const task = withCost(makeTask({ taskId: "t1", createdAt: 1 }), {
    model: "model-a",
    inputTokens: 1_000_000,
    outputTokens: 0,
  });
  const feed = buildFeed([task], [], [], new Map(), { now: NOW, pricing: TEST_PRICING });
  assert.ok(feed[1].includes("↑1000000 ↓0 $1.0000"), feed[1]);
});

test("costSourceFor：sidecar 与 result.cost 均无 → null（—）", () => {
  const task = makeTask({ taskId: "t1", status: "running", createdAt: 1 });
  const feed = buildFeed([task], [], [], new Map(), { now: NOW, pricing: TEST_PRICING });
  assert.ok(feed[1].includes("— —"), feed[1]);
});

test("表头含 usage/费用", () => {
  const feed = buildFeed([], [], [], new Map(), { now: NOW });
  assert.equal(feed[0], renderFarmTable([], NOW).split("\n")[0] + " usage/费用 投递");
});

test("footer 恒含合计口径注记（票 04 D3-A）：静态文案不随任务费用增减；金额求和已删除", () => {
  const done = withCost(makeTask({ taskId: "done", status: "done", createdAt: 1 }), {
    model: "model-a",
    inputTokens: 1_000_000,
    outputTokens: 0,
  }); // $1.0000（终态：不进面板，仅作历史上下文）
  const aborted = makeTask({ taskId: "aborted", status: "aborted", createdAt: 2 });
  const abortedUsage: UsageSidecar = { model: "model-b", inputTokens: 1_000_000, outputTokens: 0, updatedAt: NOW }; // $10.0000
  const unknown = withCost(makeTask({ taskId: "unknown", status: "done", createdAt: 3 }), {
    model: "unknown-model",
    inputTokens: 1_000_000,
    outputTokens: 0,
  }); // 未知模型排除
  const nodata = makeTask({ taskId: "nodata", status: "running", createdAt: 4 }); // 无数据排除
  const feed = buildFeed([done, aborted, unknown, nodata], [], [], new Map([["aborted", abortedUsage]]), {
    now: NOW,
    pricing: TEST_PRICING,
  });
  // active-only：仅 nodata（running）渲染一行；终态四行不进面板
  assert.equal(feed.length, 3); // 表头 + 1 活跃行 + footer
  assert.equal(feed[2], "活跃 1 · 排队 0 · 任务执行完即可清理 · 合计=保留期内列表费用（历史不累计）");
  assert.ok(!feed[2].includes("合计 $"), feed[2]);
  assert.ok(!feed[1].includes("$"), feed[1]); // nodata 行无金额
});

test("footer 注记恒在：无可计金额任务也含合计口径注记（不含金额求和）", () => {
  const task = makeTask({ taskId: "t1", status: "running", createdAt: 1 });
  const feed = buildFeed([task], [], [], new Map(), { now: NOW, pricing: TEST_PRICING });
  assert.equal(feed[2], "活跃 1 · 排队 0 · 任务执行完即可清理 · 合计=保留期内列表费用（历史不累计）");
});

// ── 票 04：active-only 数据源（splitTasksForDisplay 接入，工具侧兜底） ─────────

test("active-only：终态（done/aborted/cancelled/failed 用尽）不渲染，只有 3 种活跃态行", () => {
  const tasks = [
    makeTask({ taskId: "q1", status: "queued", createdAt: 100 }),
    makeTask({ taskId: "r1", status: "running", createdAt: 200 }),
    makeTask({ taskId: "t1", status: "timeout", createdAt: 300 }),
    makeTask({ taskId: "d1", status: "done", createdAt: 400 }),
    makeTask({ taskId: "a1", status: "aborted", createdAt: 500 }),
    makeTask({ taskId: "c1", status: "cancelled", createdAt: 600 }),
    makeTask({ taskId: "f1", status: "failed", attempts: 2, maxAttempts: 2, createdAt: 700 }), // 用尽=终态
  ];
  const feed = buildFeed(tasks, [], [], new Map(), { now: NOW });
  assert.equal(feed.length, 5); // 表头 + 3 活跃行 + footer
  const rows = feed.slice(1, -1).map((line) => line.slice(0, 8).trim());
  assert.deepEqual(rows, ["q1", "r1", "t1"]);
  for (const terminal of ["d1", "a1", "c1", "f1"]) {
    assert.ok(!feed.join("\n").includes(terminal), `终态 ${terminal} 不应在面板`);
  }
});

test("active 行序 createdAt ASC + taskId 破序（乱序输入 + 终态混入）", () => {
  const tasks = [
    makeTask({ taskId: "d2", status: "done", createdAt: 999 }),
    makeTask({ taskId: "b1", status: "running", createdAt: 200 }),
    makeTask({ taskId: "b2", status: "running", createdAt: 200 }), // 同 createdAt → taskId 破序
    makeTask({ taskId: "a1", status: "queued", createdAt: 100 }),
    makeTask({ taskId: "c1", status: "cancelled", createdAt: 300 }),
  ];
  const feed = buildFeed(tasks, [], [], new Map(), { now: NOW });
  const rows = feed.slice(1, -1).map((line) => line.slice(0, 8).trim());
  assert.deepEqual(rows, ["a1", "b1", "b2"]);
});

test("折叠行位置：>100 活跃时「另有 K 条排队」紧邻 footer 前一行", () => {
  const tasks = Array.from({ length: 103 }, (_, i) =>
    makeTask({ taskId: `t${String(i + 1).padStart(3, "0")}`, status: i < 100 ? "queued" : "running", createdAt: i + 1 }),
  );
  const feed = buildFeed(tasks, [], [], new Map(), { now: NOW });
  assert.equal(feed.length, 103); // 表头 + 100 行 + 折叠行 + footer
  assert.equal(feed[101], "另有 3 条排队");
  assert.equal(feed[102], "活跃 103 · 排队 100 · 任务执行完即可清理 · 合计=保留期内列表费用（历史不累计）");
});
