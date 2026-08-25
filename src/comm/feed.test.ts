// src/comm/feed.test.ts
// buildFeed 纯渲染用例（票 01 plan §5.3 清单全覆盖）。
// 只断言输出行文本（表头/5 列宽对齐/usage/投递态/截断/recent N/存活计数），零 I/O。
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

test("空 tasks：只有表头 + 计数行（存活 0）", () => {
  const feed = buildFeed([], [], [], new Map(), { now: NOW });
  assert.deepEqual(feed, [
    "taskId   role         status   attempts 耗时 usage/费用 投递",
    "共 0 个任务 · 存活 0 · 会话保留 7 天",
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

test("recent N（BE#5）：>N 条任务只渲染最近 N 行，计数行仍显总数", () => {
  const tasks = [1, 2, 3, 4, 5].map((i) => makeTask({ taskId: `t${i}`, createdAt: i }));
  const feed = buildFeed(tasks, [], [], new Map(), { now: NOW, recentN: 2 });

  assert.equal(feed.length, 4); // 表头 + 2 行 + 计数
  const order = feed.slice(1, -1).map((line) => line.slice(0, 8).trim());
  assert.deepEqual(order, ["t4", "t5"]); // 最新创建的 2 条
  assert.equal(feed[3], "共 5 个任务 · 存活 0 · 会话保留 7 天（显示最近 2/5）");
});

test("缺省 recentN=50（BE#5）：>50 条任务不传 recentN 只渲染尾 50 行 + 计数行", () => {
  const tasks = Array.from({ length: 53 }, (_, i) =>
    makeTask({ taskId: `t${i + 1}`, createdAt: i + 1 }),
  );
  const feed = buildFeed(tasks, [], [], new Map(), { now: NOW });

  assert.equal(feed.length, 52); // 表头 + 50 行 + 计数
  const order = feed.slice(1, -1).map((line) => line.slice(0, 8).trim());
  assert.equal(order.length, 50);
  assert.deepEqual(order, Array.from({ length: 50 }, (_, i) => `t${i + 4}`));
  assert.equal(feed[51], "共 53 个任务 · 存活 0 · 会话保留 7 天（显示最近 50/53）");
});

test("recentN <= 0：不截断，渲染全部", () => {
  const tasks = [1, 2, 3].map((i) => makeTask({ taskId: `t${i}`, createdAt: i }));
  const feed = buildFeed(tasks, [], [], new Map(), { now: NOW, recentN: 0 });
  assert.equal(feed.length, 5); // 表头 + 3 行 + 计数
  assert.ok(feed[4].startsWith("共 3 个任务"));
});

test("存活计数：presence 含过期项 → 存活 M 只计 alive", () => {
  const alive = { taskId: "t1", paneId: "p1", role: "r", depth: 1, pid: 1, heartbeatAt: NOW };
  const expired = { taskId: "t2", paneId: "p2", role: "r", depth: 1, pid: 2, heartbeatAt: NOW - 20_000 };
  const feed = buildFeed([], [alive, expired], [], new Map(), { now: NOW });
  assert.equal(feed[1], "共 0 个任务 · 存活 1 · 会话保留 7 天");
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

test("costSourceFor：sidecar 优先于 result.cost", () => {
  const task = withCost(makeTask({ taskId: "t1", status: "done", createdAt: 1 }), {
    model: "model-b",
    inputTokens: 1_000_000,
    outputTokens: 0,
  });
  const usage: UsageSidecar = { model: "model-a", inputTokens: 1_000_000, outputTokens: 0, updatedAt: NOW };
  const feed = buildFeed([task], [], [], new Map([["t1", usage]]), { now: NOW, pricing: TEST_PRICING });
  assert.ok(feed[1].includes("$1.0000"), feed[1]);
  assert.ok(!feed[1].includes("$10.0000"), feed[1]);
});

test("costSourceFor：无 sidecar → result.cost 兜底", () => {
  const task = withCost(makeTask({ taskId: "t1", status: "done", createdAt: 1 }), {
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

test("合计行：done 用 result.cost、aborted 用 sidecar、未知模型与无数据排除", () => {
  const done = withCost(makeTask({ taskId: "done", status: "done", createdAt: 1 }), {
    model: "model-a",
    inputTokens: 1_000_000,
    outputTokens: 0,
  }); // $1.0000
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
  assert.ok(feed[5].includes("合计 $11.0000"), feed[5]);
});

test("合计行：无可计任务不追加「合计」段", () => {
  const task = makeTask({ taskId: "t1", status: "running", createdAt: 1 });
  const feed = buildFeed([task], [], [], new Map(), { now: NOW, pricing: TEST_PRICING });
  assert.ok(!feed[2].includes("合计"), feed[2]);
});
