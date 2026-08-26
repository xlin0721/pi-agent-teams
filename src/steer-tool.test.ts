// src/steer-tool.test.ts
// 票 03 steer 工具纯逻辑单测（plan §6 用例 1-12）：
//   A（executeSteer/steerAckText/steerRejectText）+ B（buildSteerMessageArgs/
//   buildSteerSink/steerBubbleLines/formatClockTime/resolveOwnPaneId）。
// 只断言外部行为：deps 注入（fake readTask/deliver/pi API），零 I/O 真文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMsgMessageArgs,
  buildSteerMessageArgs,
  buildSteerSink,
  executeMsg,
  executeResume,
  executeSteer,
  formatClockTime,
  msgAckText,
  msgPartialAckText,
  resolveMsgFrom,
  resolveMeetingTargets,
  resolveMsgTargets,
  resolveOwnPaneId,
  resumeAckText,
  resumeRejectText,
  steerAckText,
  steerBubbleLines,
  steerRejectText,
} from "./steer-tool.ts";
import type { MsgToolDeps, ResumeToolDeps, SteerToolDeps } from "./steer-tool.ts";
import type { DeliverInput, InboxMessage } from "./task-core/steer.ts";
import type { TaskRecord } from "./task-core/store.ts";
import type { Presence } from "./comm/presence.ts";

const TASK_ID = "abcdef1234567890";

// ── fixture 构造助手 ───────────────────────────────────────────────────────

function makeTask(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    type: "spawn",
    parentId: null,
    depth: 1,
    status: "running",
    owner: "owner",
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs: 600,
    attempts: 0,
    maxAttempts: 2,
    backoffSecs: [5, 30],
    payload: {
      spawn: { role: "", prompt: "", cwd: "", resumeFrom: null, paneId: "", form: "tui" },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: ["all"], delivery: "notice", content: "" },
      schedule: { mode: "once", cron: "", intervalSecs: 0, onceAt: 0, lastRun: 0, nextRun: 0, firedTaskIds: [] },
    },
    result: { sessionDir: "", exitCode: null, cost: { model: "", inputTokens: 0, outputTokens: 0 } },
    ...over,
  };
}

function runningWithPaneId(paneId: string): TaskRecord {
  return makeTask({ status: "running", payload: { ...makeTask().payload, spawn: { ...makeTask().payload.spawn, paneId } } });
}

function steerMsg(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    msgId: "00000000-0000-0000-0000-000000000001",
    type: "steer",
    from: "main",
    to: "pane-1",
    delivery: "directive",
    content: "看这里",
    status: "pending",
    ts: 1700000000000,
    ...over,
  };
}

interface DeliverCall {
  type: string;
  from: string;
  to: string;
  delivery: string;
  content: string;
}

function makeDeps(
  record: TaskRecord | null,
  calls: DeliverCall[],
): SteerToolDeps {
  return {
    readTask: async () => record,
    deliver: async (input) => {
      calls.push({
        type: input.type,
        from: input.from,
        to: input.to,
        delivery: input.delivery,
        content: input.content,
      });
      return { ...steerMsg(), type: input.type, to: input.to, content: input.content };
    },
  };
}

const resultText = (r: Awaited<ReturnType<typeof executeSteer>>): string =>
  r.content.map((c) => c.text).join("\n");

// ── 票 04/08 fixture 构造助手 ─────────────────────────────────────────────

function makePresence(over: Partial<Presence> = {}): Presence {
  return {
    taskId: "task-1",
    paneId: "pane-1",
    role: "worker",
    depth: 2,
    pid: 100,
    heartbeatAt: 1700000000000,
    ...over,
  };
}

function msgMsg(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    msgId: "00000000-0000-0000-0000-000000000002",
    type: "msg",
    from: "main",
    to: "pane-1",
    delivery: "notice",
    content: "hi",
    status: "pending",
    ts: 1700000000001,
    ...over,
  };
}

function runningTaskWith(paneId: string, role: string): TaskRecord {
  return makeTask({
    status: "running",
    payload: { ...makeTask().payload, spawn: { ...makeTask().payload.spawn, paneId, role } },
  });
}

// ── 1. steerAckText ────────────────────────────────────────────────────────

test("steerAckText：✅ 已向 taskId 前 8 位发送 steer（其当前工具跑完后生效）", () => {
  assert.equal(
    steerAckText(TASK_ID),
    "✅ 已向 abcdef12 发送 steer（其当前工具跑完后生效）",
  );
});

// ── 2. executeSteer running 通过 ────────────────────────────────────────────

test("executeSteer：running + paneId 非空 → deliver 恰 1 次、入参形状正确、返回 ack", async () => {
  const calls: DeliverCall[] = [];
  const r = await executeSteer(
    { targetTaskId: TASK_ID, content: "fix-this" },
    makeDeps(runningWithPaneId("42"), calls),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: "steer",
    from: "main",
    to: "42",
    delivery: "directive",
    content: "fix-this",
  });
  assert.equal(resultText(r), steerAckText(TASK_ID));
});

// ── 3. executeSteer 终态拒绝 ────────────────────────────────────────────────

test("executeSteer：终态（done/aborted/failed/cancelled）→ deliver 零调用 + 已结束/farm_status 文案", async () => {
  for (const status of ["done", "aborted", "failed", "cancelled"] as const) {
    const calls: DeliverCall[] = [];
    const r = await executeSteer(
      { targetTaskId: TASK_ID, content: "x" },
      makeDeps(makeTask({ status }), calls),
    );
    assert.equal(calls.length, 0, `${status} 不应 deliver`);
    assert.match(resultText(r), /已结束/);
    assert.match(resultText(r), /farm_status/);
  }
});

// ── 4. executeSteer queued 拒绝 ─────────────────────────────────────────────

test("executeSteer：queued → deliver 零调用 + 排队/farm_status 文案", async () => {
  const calls: DeliverCall[] = [];
  const r = await executeSteer(
    { targetTaskId: TASK_ID, content: "x" },
    makeDeps(makeTask({ status: "queued" }), calls),
  );
  assert.equal(calls.length, 0);
  assert.match(resultText(r), /排队/);
  assert.match(resultText(r), /farm_status/);
});

// ── 5. executeSteer timeout 拒绝 ────────────────────────────────────────────

test("executeSteer：timeout → deliver 零调用 + 超时文案", async () => {
  const calls: DeliverCall[] = [];
  const r = await executeSteer(
    { targetTaskId: TASK_ID, content: "x" },
    makeDeps(makeTask({ status: "timeout" }), calls),
  );
  assert.equal(calls.length, 0);
  assert.match(resultText(r), /超时/);
});

// ── 6. executeSteer not-found ───────────────────────────────────────────────

test("executeSteer：readTask → null → deliver 零调用 + 未找到任务文案", async () => {
  const calls: DeliverCall[] = [];
  const r = await executeSteer(
    { targetTaskId: TASK_ID, content: "x" },
    makeDeps(null, calls),
  );
  assert.equal(calls.length, 0);
  assert.match(resultText(r), /未找到任务/);
});

// ── 7. executeSteer paneId 缺失跳过 ─────────────────────────────────────────

test("executeSteer：running + paneId=\"\" → deliver 零调用 + 未就绪文案", async () => {
  const calls: DeliverCall[] = [];
  const r = await executeSteer(
    { targetTaskId: TASK_ID, content: "x" },
    makeDeps(runningWithPaneId(""), calls),
  );
  assert.equal(calls.length, 0);
  assert.match(resultText(r), /未就绪/);
});

// ── 7b. executeSteer 畸形记录（缺 payload / payload.spawn）不抛 ───────────

test("executeSteer：running + payload/payload.spawn 缺失（畸形记录）→ 不抛 + 未就绪文案", async () => {
  const noPayload = { ...makeTask(), payload: undefined } as unknown as TaskRecord;
  const noSpawn = {
    ...makeTask(),
    payload: { ...makeTask().payload, spawn: undefined },
  } as unknown as TaskRecord;
  for (const record of [noPayload, noSpawn]) {
    const calls: DeliverCall[] = [];
    const r = await executeSteer(
      { targetTaskId: TASK_ID, content: "x" },
      makeDeps(record, calls),
    );
    assert.equal(calls.length, 0);
    assert.match(resultText(r), /未就绪/);
  }
});

// ── 8. buildSteerMessageArgs ────────────────────────────────────────────────

test("buildSteerMessageArgs：BE#7 两参形状断言锚点（deliverAs:steer + triggerTurn:true）", () => {
  const m = steerMsg({ content: "turn", from: "main", ts: 1234567890 });
  assert.deepEqual(buildSteerMessageArgs(m), {
    message: {
      customType: "farm.steer",
      content: "turn",
      display: true,
      details: { from: "main", ts: 1234567890 },
    },
    options: { deliverAs: "steer", triggerTurn: true },
  });
});

test("C7：buildSteerMessageArgs / buildMsgMessageArgs 剥 ANSI（A 侧 from 与 B 侧同口径）", () => {
  const ansiFrom = "\u001b[31mmain\u001b[0m";
  const s = steerMsg({ from: ansiFrom, ts: 1234567890 });
  assert.equal(buildSteerMessageArgs(s).message.details.from, "main");
  const m = msgMsg({ from: ansiFrom, delivery: "directive", ts: 1234567891 });
  assert.equal(buildMsgMessageArgs(m).message.details.from, "main");
});

// ── 9. buildSteerSink（fake pi API） ────────────────────────────────────────

test("buildSteerSink：steer → sendMessage 恰 1 次且两参形状同 8；msg → 恰 1 次（票 04 追加）", () => {
  const calls: Array<[unknown, unknown]> = [];
  const pi = {
    sendMessage: (message: unknown, options: unknown): void => {
      calls.push([message, options]);
    },
  };
  const sink = buildSteerSink(pi);
  const m = steerMsg({ content: "turn", from: "main", ts: 1234567890 });
  sink(m);
  assert.equal(calls.length, 1);
  const args = buildSteerMessageArgs(m);
  assert.deepEqual(calls[0]?.[0], args.message);
  assert.deepEqual(calls[0]?.[1], args.options);

  // msg（票 04）：directive → 恰 1 次调用，两参形状同 buildMsgMessageArgs
  const mm = msgMsg({ delivery: "directive", content: "go", from: "main", ts: 1234567891 });
  sink(mm);
  assert.equal(calls.length, 2);
  const margs = buildMsgMessageArgs(mm);
  assert.deepEqual(calls[1]?.[0], margs.message);
  assert.deepEqual(calls[1]?.[1], margs.options);
});

// ── 10. steerBubbleLines ────────────────────────────────────────────────────

test("steerBubbleLines：首行含来自+时间戳，正文含 content，超长折行每行可见宽 ≤ width", () => {
  const t = 1700000000000;
  const lines = steerBubbleLines({ content: "看这里", details: { from: "main", ts: t } }, 40);
  assert.match(lines[0] ?? "", /来自 main/);
  assert.match(lines[0] ?? "", /\d{2}:\d{2}:\d{2}/);
  assert.ok(lines.slice(1).join("").includes("看这里"));

  // 超长 ASCII 内容折行：body 每行 ≤ width
  const wide = steerBubbleLines({ content: "a".repeat(100), details: { from: "main", ts: t } }, 20);
  assert.ok(wide.length > 1, "超长内容应折成多行");
  for (const line of wide.slice(1)) {
    assert.ok(line.length <= 20, `折行后每行 ≤ 20，实际 ${line.length}: ${line}`);
  }
});

test("steerBubbleLines：剥除 content/from 的 ANSI 与控制符（TUI 注入面）", () => {
  const t = 1700000000000;
  const lines = steerBubbleLines(
    {
      content: "\x1b[31m红色\x1b[0m看\x07这里",
      details: { from: "\x1b[1m主\x07人\x1b[0m", ts: t },
    },
    40,
  );
  // header 无 ANSI/控制符残留，from 已剥除
  assert.ok(!/\x1b/.test(lines[0] ?? ""), "header 不应含 ESC");
  assert.ok(!/\x07/.test(lines[0] ?? ""), "header 不应含 BEL");
  assert.match(lines[0] ?? "", /来自 主人/);
  const body = lines.slice(1).join("");
  assert.ok(!/\x1b/.test(body), "body 不应含 ESC");
  assert.ok(!/\x07/.test(body), "body 不应含 BEL");
  assert.ok(body.includes("红色看这里"));
});

// ── 11. formatClockTime ─────────────────────────────────────────────────────

test("formatClockTime：epoch ms → HH:MM:SS 本地时区", () => {
  const ts = 1700000000000;
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  const expected = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  assert.equal(formatClockTime(ts), expected);
  assert.match(formatClockTime(ts), /^\d{2}:\d{2}:\d{2}$/);
});

// ── 12. resolveOwnPaneId ────────────────────────────────────────────────────

test("resolveOwnPaneId：paneId 空→非空 轮询解析成功", async () => {
  let reads = 0;
  const readTask = async (): Promise<TaskRecord | null> => {
    reads++;
    return runningWithPaneId(reads >= 2 ? "42" : "");
  };
  const paneId = await resolveOwnPaneId(readTask, TASK_ID, { pollMs: 5, timeoutMs: 2000 });
  assert.equal(paneId, "42");
});

test("resolveOwnPaneId：恒空超时返回 \"\"", async () => {
  const readTask = async (): Promise<TaskRecord | null> => runningWithPaneId("");
  const paneId = await resolveOwnPaneId(readTask, TASK_ID, { pollMs: 5, timeoutMs: 50 });
  assert.equal(paneId, "");
});

// ── 票 TD2：AbortSignal 提前退出 ──────────────────────────────────────────

test("resolveOwnPaneId：signal 第 2 次 readTask 时 abort → 返回 \"\" 且 readTask 调用 ≤3", async () => {
  const ac = new AbortController();
  let reads = 0;
  const readTask = async (): Promise<TaskRecord | null> => {
    reads++;
    if (reads === 2) ac.abort();
    return runningWithPaneId(""); // 恒无 paneId
  };
  const paneId = await resolveOwnPaneId(readTask, TASK_ID, {
    signal: ac.signal,
    pollMs: 5,
    timeoutMs: 1000,
  });
  assert.equal(paneId, "");
  assert.ok(reads <= 3, `abort 后应提前退出，readTask 调用 ${reads} 次 > 3`);
});

// ── steerRejectText 分型（补充断言：直接覆盖各拒绝文案锚点） ────────────────

test("steerRejectText：null/queued/timeout/终态 分型文案", () => {
  assert.match(steerRejectText(null, TASK_ID), /未找到任务/);
  assert.match(steerRejectText("queued", TASK_ID), /排队/);
  assert.match(steerRejectText("timeout", TASK_ID), /超时/);
  assert.match(steerRejectText("done", TASK_ID), /已结束（完成）/);
  assert.match(steerRejectText("cancelled", TASK_ID), /已结束（已取消）/);
});

// ── 票 04：msg 工具纯逻辑（用例 1-12） ────────────────────────────────────

test("resolveMsgTargets：[\"all\"] + presence 多实例 → 全部 paneId（去重保序）", () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", heartbeatAt: now }),
    makePresence({ taskId: "b", paneId: "p2", heartbeatAt: now - 1000 }),
    makePresence({ taskId: "c", paneId: "p1", heartbeatAt: now - 2000 }), // 重复 paneId
  ];
  assert.deepEqual(resolveMsgTargets(["all"], presences, [], now), ["p1", "p2"]);
});

test("resolveMsgTargets：[\"all\"] + presence 空 → 回退 running 记录 paneId（空 paneId 跳过）", () => {
  const now = 1700000000000;
  const running = [
    runningTaskWith("", "w"), // 空 paneId 跳过
    runningTaskWith("p9", "w"),
    runningTaskWith("p9", "w"), // 重复
  ];
  assert.deepEqual(resolveMsgTargets(["all"], [], running, now), ["p9"]);
});

test("resolveMsgTargets：[role] + 同名多实例 presence → fan-out 全部 paneId", () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", role: "worker", heartbeatAt: now }),
    makePresence({ taskId: "b", paneId: "p2", role: "worker", heartbeatAt: now }),
    makePresence({ taskId: "c", paneId: "p3", role: "other", heartbeatAt: now }),
  ];
  assert.deepEqual(resolveMsgTargets(["worker"], presences, [], now), ["p1", "p2"]);
});

test("resolveMsgTargets：[role] + presence 缺失 → 回退 running 记录 role 匹配", () => {
  const now = 1700000000000;
  const running = [
    runningTaskWith("p1", "worker"),
    runningTaskWith("p2", "other"),
    runningTaskWith("p3", "worker"),
  ];
  assert.deepEqual(resolveMsgTargets(["worker"], [], running, now), ["p1", "p3"]);
});

test("resolveMsgTargets：role 不存在 + 无 running 匹配 → []（0 命中）", () => {
  const now = 1700000000000;
  assert.deepEqual(
    resolveMsgTargets(["ghost"], [makePresence({ role: "worker", heartbeatAt: now })], [], now),
    [],
  );
});

test("resolveMsgTargets：混合 [\"all\", role] → 去重合并", () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", role: "worker", heartbeatAt: now }),
    makePresence({ taskId: "b", paneId: "p2", role: "other", heartbeatAt: now }),
  ];
  assert.deepEqual(resolveMsgTargets(["all", "worker"], presences, [], now), ["p1", "p2"]);
});

test("resolveMsgTargets：\"main\" 命中（有 presence）→ [\"main\"]（不解析 role、不依赖心跳）", () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", role: "worker", heartbeatAt: now }),
  ];
  assert.deepEqual(resolveMsgTargets(["main"], presences, [], now), ["main"]);
});

test("resolveMsgTargets：\"main\" 命中（无 presence）→ 仍 [\"main\"]（main 常驻收件方）", () => {
  const now = 1700000000000;
  assert.deepEqual(resolveMsgTargets(["main"], [], [], now), ["main"]);
});

test("resolveMsgTargets：\"all\" 不含 \"main\"（main 不污染 listAlive/all 语义）", () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", heartbeatAt: now }),
    makePresence({ taskId: "b", paneId: "p2", heartbeatAt: now }),
  ];
  assert.deepEqual(resolveMsgTargets(["all"], presences, [], now), ["p1", "p2"]);
});

test("resolveMsgTargets：[\"main\",\"main\"] → 去重为 [\"main\"]", () => {
  const now = 1700000000000;
  assert.deepEqual(resolveMsgTargets(["main", "main"], [], [], now), ["main"]);
});

test("resolveMeetingTargets：depth≥2 实例被过滤（presence.depth + running.depth 双路径）；depth<2 保留", () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", role: "worker", depth: 1, heartbeatAt: now }),
    makePresence({ taskId: "b", paneId: "p2", role: "worker", depth: 2, heartbeatAt: now }),
  ];
  const running = [
    makeTask({
      taskId: "r1", status: "running", depth: 1,
      payload: { ...makeTask().payload, spawn: { ...makeTask().payload.spawn, paneId: "rp1", role: "worker" } },
    }),
    makeTask({
      taskId: "r2", status: "running", depth: 2,
      payload: { ...makeTask().payload, spawn: { ...makeTask().payload.spawn, paneId: "rp2", role: "worker" } },
    }),
  ];
  assert.deepEqual(resolveMeetingTargets(["all"], presences, running, now), ["p1"]);
  assert.deepEqual(resolveMeetingTargets(["worker"], presences, running, now), ["p1"]);
});

test("resolveMeetingTargets：presence 空 → 回退 running 且过滤 depth≥2；\"main\" 恒保留", () => {
  const now = 1700000000000;
  const running = [
    makeTask({
      taskId: "r1", status: "running", depth: 1,
      payload: { ...makeTask().payload, spawn: { ...makeTask().payload.spawn, paneId: "rp1", role: "worker" } },
    }),
    makeTask({
      taskId: "r2", status: "running", depth: 2,
      payload: { ...makeTask().payload, spawn: { ...makeTask().payload.spawn, paneId: "rp2", role: "worker" } },
    }),
  ];
  assert.deepEqual(resolveMeetingTargets(["worker"], [], running, now), ["rp1"]);
  assert.deepEqual(resolveMeetingTargets(["main"], [], running, now), ["main"]);
});

// ── E4（C9）：resolveMsgTargets excludeDepthGE + 编排集==投递集同源不变量 ────────

test("resolveMsgTargets：opts.excludeDepthGE=2 过滤 depth≥2（presence+running 双路径）；缺省不过滤（FR5）", () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", role: "worker", depth: 1, heartbeatAt: now }),
    makePresence({ taskId: "b", paneId: "p2", role: "worker", depth: 2, heartbeatAt: now }),
    makePresence({ taskId: "c", paneId: "p3", role: "worker", heartbeatAt: now, depth: undefined as unknown as number }), // depth 缺省（旧记录）→ 保守放行
  ];
  const running = [
    makeTask({
      taskId: "r1", status: "running", depth: 1,
      payload: { ...makeTask().payload, spawn: { ...makeTask().payload.spawn, paneId: "rp1", role: "worker" } },
    }),
    makeTask({
      taskId: "r2", status: "running", depth: 2,
      payload: { ...makeTask().payload, spawn: { ...makeTask().payload.spawn, paneId: "rp2", role: "worker" } },
    }),
  ];
  // 过滤生效：depth≥2 排除、depth 缺省保留、presence 空时 running 回退同样过滤
  assert.deepEqual(resolveMsgTargets(["all"], presences, running, now, { excludeDepthGE: 2 }), ["p1", "p3"]);
  assert.deepEqual(resolveMsgTargets(["worker"], [], running, now, { excludeDepthGE: 2 }), ["rp1"]);
  // 缺省 opts：不过滤（FR5『all 含 depth-2 worker 收信』契约不变）
  assert.deepEqual(resolveMsgTargets(["all"], presences, running, now), ["p1", "p2", "p3"]);
});

test("resolveMeetingTargets 与 resolveMsgTargets(...,{excludeDepthGE:2}) 同源不变量（编排集==投递集）", () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", role: "worker", depth: 1, heartbeatAt: now }),
    makePresence({ taskId: "b", paneId: "p2", role: "worker", depth: 2, heartbeatAt: now }),
    makePresence({ taskId: "c", paneId: "p3", role: "explorer", depth: 1, heartbeatAt: now }),
  ];
  const running = [
    makeTask({
      taskId: "r2", status: "running", depth: 2,
      payload: { ...makeTask().payload, spawn: { ...makeTask().payload.spawn, paneId: "rp2", role: "worker" } },
    }),
  ];
  assert.deepEqual(
    resolveMeetingTargets(["all"], presences, running, now),
    resolveMsgTargets(["all"], presences, running, now, { excludeDepthGE: 2 }),
  );
  assert.deepEqual(
    resolveMeetingTargets(["worker", "explorer"], presences, running, now),
    resolveMsgTargets(["worker", "explorer"], presences, running, now, { excludeDepthGE: 2 }),
  );
});

test("executeMsg：opts {excludeDepthGE:2, depthCap:2} 会议投递只到 depth-1 且消息带 depthCap（读侧兜底标记）", async () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", role: "worker", depth: 1, heartbeatAt: now }),
    makePresence({ taskId: "b", paneId: "p2", role: "worker", depth: 2, heartbeatAt: now }),
  ];
  const calls: DeliverInput[] = [];
  const deps: MsgToolDeps = {
    readPresences: async () => presences,
    scanTasks: async () => [],
    deliver: async (input) => {
      calls.push(input);
      return { ...msgMsg(), ...input };
    },
    from: "main",
    now: () => now,
  };
  const r = await executeMsg(
    { targets: ["all"], delivery: "directive", content: "会议" },
    deps,
    { excludeDepthGE: 2, depthCap: 2 },
  );
  assert.equal(calls.length, 1); // depth-2 不被投递
  assert.deepEqual(calls[0], {
    type: "msg", from: "main", to: "p1", delivery: "directive", content: "会议", depthCap: 2,
  });
  assert.match(resultText(r), /已向 1 个 agent 发送 directive/);
});

test("resolveMsgFrom：\"\" → main；presence 命中 → paneId；缺失 → readTask paneId；都缺 → taskId 兜底", () => {
  assert.equal(resolveMsgFrom("", [], null), "main");
  const now = 1700000000000;
  assert.equal(
    resolveMsgFrom("t1", [makePresence({ taskId: "t1", paneId: "p1", heartbeatAt: now })], null),
    "p1",
  );
  assert.equal(resolveMsgFrom("t2", [], runningTaskWith("p2", "w")), "p2");
  assert.equal(resolveMsgFrom("t3", [], makeTask()), "t3");
});

test("executeMsg：N 命中 → deliver 恰 N 次、形状正确 + ack 含「已向 N 个」", async () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", role: "w", heartbeatAt: now }),
    makePresence({ taskId: "b", paneId: "p2", role: "w", heartbeatAt: now }),
  ];
  const calls: DeliverInput[] = [];
  const deps: MsgToolDeps = {
    readPresences: async () => presences,
    scanTasks: async () => [],
    deliver: async (input) => {
      calls.push(input);
      return { ...msgMsg(), ...input };
    },
    from: "main",
    now: () => now,
  };
  const r = await executeMsg({ targets: ["all"], delivery: "directive", content: "go" }, deps);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { type: "msg", from: "main", to: "p1", delivery: "directive", content: "go" });
  assert.deepEqual(calls[1], { type: "msg", from: "main", to: "p2", delivery: "directive", content: "go" });
  assert.match(resultText(r), /已向 2 个 agent 发送 directive/);
});

test("executeMsg：0 命中 → deliver 零调用 + 「无在运行的接收者」", async () => {
  const calls: DeliverInput[] = [];
  const deps: MsgToolDeps = {
    readPresences: async () => [],
    scanTasks: async () => [],
    deliver: async (input) => {
      calls.push(input);
      return { ...msgMsg(), ...input };
    },
    from: "main",
  };
  const r = await executeMsg({ targets: ["ghost"], delivery: "notice", content: "x" }, deps);
  assert.equal(calls.length, 0);
  assert.match(resultText(r), /无在运行的接收者/);
});

test("buildMsgMessageArgs：notice → farm.msg.notice + followUp；directive → farm.msg.directive + steer+triggerTurn", () => {
  const notice = msgMsg({ delivery: "notice", content: "n", from: "main", ts: 123 });
  assert.deepEqual(buildMsgMessageArgs(notice), {
    message: { customType: "farm.msg.notice", content: "n", display: true, details: { from: "main", ts: 123 } },
    options: { deliverAs: "followUp" },
  });
  const directive = msgMsg({ delivery: "directive", content: "d", from: "main", ts: 124 });
  assert.deepEqual(buildMsgMessageArgs(directive), {
    message: { customType: "farm.msg.directive", content: "d", display: true, details: { from: "main", ts: 124 } },
    options: { deliverAs: "steer", triggerTurn: true },
  });
});

test("buildSteerSink：msg notice → followUp（不触发回合）", () => {
  const calls: Array<[unknown, unknown]> = [];
  const pi = {
    sendMessage: (message: unknown, options: unknown): void => {
      calls.push([message, options]);
    },
  };
  const sink = buildSteerSink(pi);
  const m = msgMsg({ delivery: "notice", content: "n", from: "main", ts: 5 });
  sink(m);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.[1], { deliverAs: "followUp" });
});

test("msgAckText：格式断言（N + delivery）", () => {
  assert.equal(msgAckText(3, "notice"), "✅ 已向 3 个 agent 发送 notice（notice 只显示 / directive 触发行动）");
  assert.equal(msgAckText(0, "directive"), "✅ 已向 0 个 agent 发送 directive（notice 只显示 / directive 触发行动）");
});

test("msgPartialAckText：格式断言（sent + failed + delivery）", () => {
  assert.equal(
    msgPartialAckText(1, 2, "directive"),
    "⚠ 已向 1 个 agent 发送 directive，其中 2 条失败（notice 只显示 / directive 触发行动）",
  );
});

test("executeMsg：单条 deliver 抛错 → 不中断、其余仍投递 + ack 注明失败数", async () => {
  const now = 1700000000000;
  const presences = [
    makePresence({ taskId: "a", paneId: "p1", role: "w", heartbeatAt: now }),
    makePresence({ taskId: "b", paneId: "p2", role: "w", heartbeatAt: now }),
    makePresence({ taskId: "c", paneId: "p3", role: "w", heartbeatAt: now }),
  ];
  const calls: string[] = [];
  const deps: MsgToolDeps = {
    readPresences: async () => presences,
    scanTasks: async () => [],
    deliver: async (input) => {
      calls.push(input.to);
      if (input.to === "p2") throw new Error("boom");
      return { ...msgMsg(), ...input };
    },
    from: "main",
    now: () => now,
  };
  const r = await executeMsg({ targets: ["all"], delivery: "directive", content: "go" }, deps);
  assert.deepEqual(calls, ["p1", "p2", "p3"]); // 抛错不中断循环
  assert.match(resultText(r), /已向 2 个 agent 发送 directive/);
  assert.match(resultText(r), /其中 1 条失败/);
});

// ── 票 08：resume 工具纯逻辑（用例 13-18） ────────────────────────────────

test("executeResume：aborted + sessionId 命中 → queued + fill resumeFrom 落盘 + ack（排队位置 N）", async () => {
  const record = makeTask({ status: "aborted", result: { ...makeTask().result, sessionDir: "/sess/t1" } });
  let written: TaskRecord | null = null;
  const deps: ResumeToolDeps = {
    readTask: async () => record,
    scanTasks: async () => (written !== null ? [written] : []),
    writeTask: async (r) => {
      written = r;
    },
    findSessionId: async () => "sess-id-123",
    owner: "owner",
    now: () => 1700000000000,
  };
  const r = await executeResume({ taskId: TASK_ID }, deps);
  const saved = written as TaskRecord | null;
  assert.ok(saved !== null);
  assert.equal(saved.status, "queued");
  assert.equal(saved.payload.spawn.resumeFrom, "sess-id-123");
  assert.equal(saved.updatedAt, 1700000000000);
  assert.equal(saved.owner, "owner");
  assert.match(resultText(r), /已恢复任务 abcdef12/);
  assert.match(resultText(r), /排队位置 1/);
});

test("executeResume：readTask null → not-found + 零 writeTask", async () => {
  let writes = 0;
  const deps: ResumeToolDeps = {
    readTask: async () => null,
    scanTasks: async () => [],
    writeTask: async () => {
      writes++;
    },
    findSessionId: async () => "x",
    owner: "owner",
  };
  const r = await executeResume({ taskId: TASK_ID }, deps);
  assert.equal(writes, 0);
  assert.match(resultText(r), /未找到任务/);
});

test("executeResume：非 aborted（queued/running/timeout/done/failed/cancelled）→ 拒绝 + 零 writeTask", async () => {
  for (const status of ["queued", "running", "timeout", "done", "failed", "cancelled"] as const) {
    let writes = 0;
    const deps: ResumeToolDeps = {
      readTask: async () => makeTask({ status }),
      scanTasks: async () => [],
      writeTask: async () => {
        writes++;
      },
      findSessionId: async () => "x",
      owner: "owner",
    };
    const r = await executeResume({ taskId: TASK_ID }, deps);
    assert.equal(writes, 0, `${status} 不应 writeTask`);
    assert.match(resultText(r), /仅 aborted 任务支持 resume/);
  }
});

test("executeResume：owner 不匹配 → cross-owner + 零 writeTask", async () => {
  let writes = 0;
  const deps: ResumeToolDeps = {
    readTask: async () => makeTask({ status: "aborted", owner: "someone-else" }),
    scanTasks: async () => [],
    writeTask: async () => {
      writes++;
    },
    findSessionId: async () => "x",
    owner: "owner",
  };
  const r = await executeResume({ taskId: TASK_ID }, deps);
  assert.equal(writes, 0);
  assert.match(resultText(r), /不属于本进程 owner/);
});

test("executeResume：findSessionId null（GC）→ 「会话已被回收」 + 留 aborted（零 writeTask）", async () => {
  let writes = 0;
  const deps: ResumeToolDeps = {
    readTask: async () =>
      makeTask({ status: "aborted", result: { ...makeTask().result, sessionDir: "/gone" } }),
    scanTasks: async () => [],
    writeTask: async () => {
      writes++;
    },
    findSessionId: async () => null,
    owner: "owner",
  };
  const r = await executeResume({ taskId: TASK_ID }, deps);
  assert.equal(writes, 0);
  assert.match(resultText(r), /会话已被回收/);
});

test("resumeAckText / resumeRejectText：文案锚点", () => {
  assert.equal(resumeAckText(TASK_ID, 3), "✅ 已恢复任务 abcdef12，将从上次对话继续（排队位置 3）");
  assert.equal(resumeAckText(TASK_ID, 0), "✅ 已恢复任务 abcdef12，将从上次对话继续（队列有空位，即将开始）");
  assert.match(resumeRejectText("not-found", TASK_ID), /未找到任务/);
  assert.match(resumeRejectText("cross-owner", TASK_ID), /不属于本进程 owner/);
  assert.match(resumeRejectText("not-aborted", TASK_ID, "failed"), /仅 aborted 任务支持 resume/);
  assert.match(resumeRejectText("not-aborted", TASK_ID, "failed"), /failed\/cancelled 请重新派发/);
  assert.match(resumeRejectText("session-gone", TASK_ID), /会话已被回收/);
});
