// src/probe.test.ts
// 06 装配票单测（probe 侧）：capability probe 结果形状解析（§13.6 A）、runProbe
// 单项失败=false 不阻断、FR9 降级门 spawnGate（L0/L1/L2，fake cli：list 抛
// CliError 带 Socket stderr → L1）、拒绝文案、角色枚举校验（枚举外拒绝/空枚举
// 文案）、排队位置、spawn ack 文案。全部 fake 注入，零真实 cli/pi 调用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "./display/split.ts";
import type { TaskRecord } from "./task-core/store.ts";
import {
  degradeRejectText,
  isL2Env,
  isPaneMode,
  listAgentRoles,
  ownDepth,
  panelChanged,
  parseProbeResult,
  queuedPosition,
  renderTaskDetail,
  resolveSpawnDepthForm,
  runProbe,
  spawnAckText,
  spawnGate,
  validateAgentRole,
  workerFormEnv,
} from "./probe.ts";
import type { ProbeDeps } from "./probe.ts";

// ── workerFormEnv（票 06 形态 env 拼装） ────────────────────────────────────

test("workerFormEnv: worker → PI_AGENT_TEAMS_FORM=worker + PI_RENDERER=<path>；tui → []", () => {
  assert.deepEqual(workerFormEnv("tui", "/x/render-mini.ts"), []);
  assert.deepEqual(workerFormEnv("worker", "/x/render-mini.ts"), [
    "PI_AGENT_TEAMS_FORM=worker",
    "PI_RENDERER=/x/render-mini.ts",
  ]);
});

// ── §1 parseProbeResult（结果形状解析） ─────────────────────────────────────

const VALID_RESULT = {
  capabilities: {
    paneMarker: true,
    steer: true,
    setActiveTools: true,
    resume: true,
    appendSystemPrompt: false,
  },
  piVersion: "0.84.1",
  probedAt: 1_700_000_000_000,
};

test("parseProbeResult: 合法形状原样归一化（五项 boolean + piVersion + probedAt）", () => {
  assert.deepEqual(parseProbeResult(VALID_RESULT), VALID_RESULT);
});

test("parseProbeResult: 多余字段容忍（config.json 携带 piBin/piScript 扩展字段）", () => {
  const raw = { ...VALID_RESULT, piBin: "/usr/local/bin/node", piScript: "cli.js", extra: 1 };
  const parsed = parseProbeResult(raw);
  assert.deepEqual(parsed, VALID_RESULT);
});

test("parseProbeResult: 非对象/数组/缺 capabilities → null", () => {
  assert.equal(parseProbeResult(null), null);
  assert.equal(parseProbeResult("x"), null);
  assert.equal(parseProbeResult([]), null);
  assert.equal(parseProbeResult({ piVersion: "v", probedAt: 1 }), null);
  assert.equal(parseProbeResult({ capabilities: "nope", piVersion: "v", probedAt: 1 }), null);
});

test("parseProbeResult: capabilities 五项任一缺失或非 boolean → null", () => {
  for (const key of ["paneMarker", "steer", "setActiveTools", "resume", "appendSystemPrompt"]) {
    const caps = { ...VALID_RESULT.capabilities };
    delete (caps as Record<string, unknown>)[key];
    assert.equal(parseProbeResult({ ...VALID_RESULT, capabilities: caps }), null, `缺 ${key}`);
    const wrong = { ...VALID_RESULT.capabilities, [key]: "yes" };
    assert.equal(parseProbeResult({ ...VALID_RESULT, capabilities: wrong }), null, `${key} 非 boolean`);
  }
});

test("parseProbeResult: piVersion 空/非 string、probedAt 非有限 number → null", () => {
  assert.equal(parseProbeResult({ ...VALID_RESULT, piVersion: "" }), null);
  assert.equal(parseProbeResult({ ...VALID_RESULT, piVersion: 1 }), null);
  assert.equal(parseProbeResult({ ...VALID_RESULT, probedAt: "now" }), null);
  assert.equal(parseProbeResult({ ...VALID_RESULT, probedAt: Number.NaN }), null);
});

// ── §1 runProbe（单项失败=false，绝不整体抛错） ─────────────────────────────

function probeDeps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    pi: {
      sendMessage: () => {},
      getActiveTools: () => ["read", "bash"],
      setActiveTools: () => {},
    },
    env: {},
    now: () => 1_700_000_000_000,
    version: "0.84.1",
    ...overrides,
  };
}

test("runProbe: resume/appendSystemPrompt 恒 true（不派生 pi --help 探测）", async () => {
  // 回归锚点（M3 票 01）：probe 不得再跑 pi --help（会加载扩展→递归→拖垮 CPU）。
  // 两 flag 是 wrapper.sh 的硬依赖，恒 true 即诚实反映现实。
  const result = await runProbe(probeDeps());
  assert.equal(result.capabilities.resume, true);
  assert.equal(result.capabilities.appendSystemPrompt, true);
});

test("runProbe: 全表面在位 → 五项全 true + piVersion/probedAt 回写", async () => {
  const result = await runProbe(probeDeps());
  assert.deepEqual(result, {
    capabilities: {
      paneMarker: true,
      steer: true,
      setActiveTools: true,
      resume: true,
      appendSystemPrompt: true,
    },
    piVersion: "0.84.1",
    probedAt: 1_700_000_000_000,
  });
});

test("runProbe: sendMessage 缺失 → steer=false，其余不牵连", async () => {
  const deps = probeDeps({ pi: { getActiveTools: () => ["read"], setActiveTools: () => {} } });
  const result = await runProbe(deps);
  assert.equal(result.capabilities.steer, false);
  assert.equal(result.capabilities.setActiveTools, true);
  assert.equal(result.capabilities.resume, true);
});

test("runProbe: setActiveTools 抛错 / getActiveTools 非 string[] → setActiveTools=false", async () => {
  const throwing = probeDeps({
    pi: {
      sendMessage: () => {},
      getActiveTools: () => ["read"],
      setActiveTools: () => {
        throw new Error("boom");
      },
    },
  });
  assert.equal((await runProbe(throwing)).capabilities.setActiveTools, false);

  const notArray = probeDeps({
    pi: {
      sendMessage: () => {},
      getActiveTools: () => "nope",
      setActiveTools: () => {},
    },
  });
  assert.equal((await runProbe(notArray)).capabilities.setActiveTools, false);
});

test("runProbe: paneMarker——PI_AGENT_TEAMS_PANE 未设或 \"1\" → true，其他值 → false", async () => {
  assert.equal((await runProbe(probeDeps({ env: {} }))).capabilities.paneMarker, true);
  assert.equal(
    (await runProbe(probeDeps({ env: { PI_AGENT_TEAMS_PANE: "1" } }))).capabilities.paneMarker,
    true,
  );
  assert.equal(
    (await runProbe(probeDeps({ env: { PI_AGENT_TEAMS_PANE: "true" } }))).capabilities.paneMarker,
    false,
  );
});

// ── §2 spawnGate（FR9 三级降级链，fake cli） ───────────────────────────────

const SOCKET_STDERR =
  '15:14:46.175  ERROR  wezterm > failed to connect to Socket("/tmp/bogus.sock"): connecting to /tmp/bogus.sock; terminating';

test("isL2Env：TERM_PROGRAM=WezTerm 或 socket 在位 → false；全缺/TERM_PROGRAM 非 WezTerm → true", () => {
  assert.equal(isL2Env({}), true);
  assert.equal(isL2Env({ TERM_PROGRAM: "iTerm.app" }), true);
  assert.equal(isL2Env({ TERM_PROGRAM: "", WEZTERM_UNIX_SOCKET: "" }), true);
  assert.equal(isL2Env({ TERM_PROGRAM: "WezTerm" }), false);
  assert.equal(isL2Env({ WEZTERM_UNIX_SOCKET: "/tmp/gui-sock-1" }), false);
  assert.equal(isL2Env({ TERM_PROGRAM: "iTerm.app", WEZTERM_UNIX_SOCKET: "/tmp/gui-sock-1" }), false);
});

test("isPaneMode：PI_AGENT_TEAMS_PANE=1 → pane 内实例（不注册 spawn、不武装 ticker 的判定为真）", () => {
  // 语义 pin（挂账②）：判定为真 = index.ts 装配点在 spawn 注册与 wireFarm 之前
  // `if (isPaneMode(process.env)) return`（farm_status 只读注册在前，pane 内仍可用）；
  // wrapper.sh 保证 export PI_AGENT_TEAMS_PANE=1（integration-m2 场景 10 锁定 env 契约）。
  assert.equal(isPaneMode({ PI_AGENT_TEAMS_PANE: "1" }), true);
});

test("isPaneMode：缺省/空串/\"0\" → 主会话形态（判定为假，正常注册 + 武装）", () => {
  assert.equal(isPaneMode({}), false);
  assert.equal(isPaneMode({ PI_AGENT_TEAMS_PANE: "" }), false);
  assert.equal(isPaneMode({ PI_AGENT_TEAMS_PANE: "0" }), false);
});

// ── ownDepth / resolveSpawnDepthForm（票 05 depth-2 核心装配） ─────────────

test("ownDepth：PI_AGENT_TEAMS_DEPTH 非负整数串 → 该值；缺省/空串/非整数/负值 → 0", () => {
  assert.equal(ownDepth({}), 0);
  assert.equal(ownDepth({ PI_AGENT_TEAMS_DEPTH: "" }), 0);
  assert.equal(ownDepth({ PI_AGENT_TEAMS_DEPTH: "0" }), 0);
  assert.equal(ownDepth({ PI_AGENT_TEAMS_DEPTH: "1" }), 1);
  assert.equal(ownDepth({ PI_AGENT_TEAMS_DEPTH: "2" }), 2);
  assert.equal(ownDepth({ PI_AGENT_TEAMS_DEPTH: "001" }), 1);
  assert.equal(ownDepth({ PI_AGENT_TEAMS_DEPTH: "abc" }), 0);
  assert.equal(ownDepth({ PI_AGENT_TEAMS_DEPTH: "2.5" }), 0);
  assert.equal(ownDepth({ PI_AGENT_TEAMS_DEPTH: "-1" }), 0);
});

test("resolveSpawnDepthForm：record depth = ownDepth+1；depth≥2 强制 worker + formForced", () => {
  assert.deepEqual(resolveSpawnDepthForm(0, "tui"), { depth: 1, form: "tui", formForced: false });
  assert.deepEqual(resolveSpawnDepthForm(0, "worker"), { depth: 1, form: "worker", formForced: false });
  assert.deepEqual(resolveSpawnDepthForm(1, "tui"), { depth: 2, form: "worker", formForced: true });
  assert.deepEqual(resolveSpawnDepthForm(1, "worker"), { depth: 2, form: "worker", formForced: true });
  assert.deepEqual(resolveSpawnDepthForm(2, "tui"), { depth: 3, form: "worker", formForced: true });
});

test("spawnGate: 环境信号缺位（无 TERM_PROGRAM=WezTerm / WEZTERM_UNIX_SOCKET）→ l2", async () => {
  const verdict = await spawnGate({ env: {}, list: async () => null });
  assert.deepEqual(verdict, { level: "l2", reason: "env-signals-missing" });
  // TERM_PROGRAM 非 WezTerm 也缺位
  const verdict2 = await spawnGate({ env: { TERM_PROGRAM: "iTerm.app" }, list: async () => null });
  assert.equal(verdict2.level, "l2");
});

test("spawnGate: TERM_PROGRAM=WezTerm 或 WEZTERM_UNIX_SOCKET 在位 + list 成功 → l0", async () => {
  assert.deepEqual(
    await spawnGate({ env: { TERM_PROGRAM: "WezTerm" }, list: async () => null }),
    { level: "l0" },
  );
  assert.deepEqual(
    await spawnGate({ env: { WEZTERM_UNIX_SOCKET: "/tmp/gui-sock-1" }, list: async () => null }),
    { level: "l0" },
  );
});

test("spawnGate: fake cli 抛 CliError 带 Socket stderr（L1 原文）→ l1 mux-unreachable", async () => {
  const verdict = await spawnGate({
    env: { TERM_PROGRAM: "WezTerm" },
    list: async () => {
      throw new CliError("wezterm cli list 失败", SOCKET_STDERR);
    },
  });
  assert.deepEqual(verdict, { level: "l1", reason: "mux-unreachable" });
});

test("spawnGate: list 返回其他 stderr（运行时错误）→ l1 list-failed（保守拒派）", async () => {
  const verdict = await spawnGate({
    env: { TERM_PROGRAM: "WezTerm" },
    list: async () => 'ERROR wezterm > unexpected response Ok(ErrorResponse("no such pane"))',
  });
  assert.deepEqual(verdict, { level: "l1", reason: "list-failed" });
});

test("spawnGate: 空 pane 列表（exit 0 但无 panes，§13.6 字面）→ l1 list-failed", async () => {
  const verdict = await spawnGate({ env: { TERM_PROGRAM: "WezTerm" }, list: async () => "" });
  assert.equal(verdict.level, "l1");
});

test("spawnGate: list 本身抛非 CliError → l1 list-failed（不崩调用方）", async () => {
  const verdict = await spawnGate({
    env: { TERM_PROGRAM: "WezTerm" },
    list: async () => {
      throw new Error("unexpected");
    },
  });
  assert.deepEqual(verdict, { level: "l1", reason: "list-failed" });
});

// ── §2 degradeRejectText（拒绝文案：引导内置 subagent，不自动路由） ──────────

test("degradeRejectText: L1/L2 文案均引导内置 subagent 工具 + 明示任务未落盘", () => {
  for (const verdict of [
    { level: "l1", reason: "mux-unreachable" },
    { level: "l1", reason: "list-failed" },
    { level: "l2", reason: "env-signals-missing" },
  ] as const) {
    const text = degradeRejectText(verdict as { level: "l1" | "l2"; reason: string });
    assert.match(text, /内置 subagent 工具/);
    assert.match(text, /任务未落盘/);
    assert.match(text, /❌ 无法派发/);
  }
});

test("degradeRejectText: L1 mux-unreachable 文案明示全 mux 级（同窗口所有 tab）", () => {
  const text = degradeRejectText({ level: "l1", reason: "mux-unreachable" });
  assert.match(text, /全 mux 级/);
  assert.match(text, /同窗口所有 tab 受影响/);
});

test("degradeRejectText: l0 调用 → TypeError（调用方错误）", () => {
  assert.throws(() => degradeRejectText({ level: "l0" }), TypeError);
});

// ── §3 角色枚举校验（US9/US10） ────────────────────────────────────────────

test("listAgentRoles: *.md 去扩展名（README.md 等也是合法角色名）、非 .md 忽略、排序确定性", () => {
  assert.deepEqual(
    listAgentRoles(() => ["worker.md", "README.md", "explorer.md", "notes.txt", ".md"]),
    ["README", "explorer", "worker"],
  );
});

test("listAgentRoles: readDir 抛错 / 非数组 → 空列表（不崩）", () => {
  assert.deepEqual(
    listAgentRoles(() => {
      throw new Error("ENOENT");
    }),
    [],
  );
  assert.deepEqual(listAgentRoles(() => "nope" as unknown as string[]), []);
});

test("validateAgentRole: agent 缺省/空串 → null（默认人设，不校验）", () => {
  assert.equal(validateAgentRole(undefined, ["worker"]), null);
  assert.equal(validateAgentRole("", ["worker"]), null);
  assert.equal(validateAgentRole("  ", ["worker"]), null);
});

test("validateAgentRole: 枚举内角色（含前后空白）→ null", () => {
  assert.equal(validateAgentRole("explorer", ["explorer", "worker"]), null);
  assert.equal(validateAgentRole(" explorer ", ["explorer"]), null);
});

test("validateAgentRole: 枚举外角色 → 拒绝 + 可用角色列表（US9）", () => {
  const error = validateAgentRole("banana", ["explorer", "worker"]);
  assert.ok(error !== null);
  assert.match(error, /未知角色 "banana"/);
  assert.match(error, /explorer, worker/);
});

test("validateAgentRole: 空枚举 + 指定角色 → 无人设可用文案 + 放置路径（US10）", () => {
  const error = validateAgentRole("explorer", []);
  assert.ok(error !== null);
  assert.match(error, /无人设可用/);
  assert.match(error, /~\/\.pi\/agent\/agents\//);
  assert.match(error, /<name>\.md/);
});

// ── §5 排队位置与 ack 文案（US1/US13） ─────────────────────────────────────

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t1",
    type: "spawn",
    parentId: null,
    depth: 1,
    status: "queued",
    owner: "pid+start",
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: 0,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs: 600,
    attempts: 0,
    maxAttempts: 2,
    backoffSecs: [5, 30],
    payload: {
      spawn: { form: "tui", role: "worker", prompt: "do it", cwd: "/tmp/p1", resumeFrom: null, paneId: "" },
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

test("queuedPosition: queued 按 createdAt↑/taskId 破序排名（1-based）", () => {
  const tasks = [
    makeTask({ taskId: "aa", createdAt: 200 }),
    makeTask({ taskId: "zz", createdAt: 100 }),
    makeTask({ taskId: "mm", createdAt: 200 }),
  ];
  assert.equal(queuedPosition(tasks, "zz"), 1);
  assert.equal(queuedPosition(tasks, "aa"), 2);
  assert.equal(queuedPosition(tasks, "mm"), 3);
});

test("queuedPosition: 任务不存在 → 0；非 queued（已出队）→ 0", () => {
  const tasks = [makeTask({ taskId: "aa" }), makeTask({ taskId: "bb", status: "running" })];
  assert.equal(queuedPosition(tasks, "missing"), 0);
  assert.equal(queuedPosition(tasks, "bb"), 0);
  assert.equal(queuedPosition(tasks, ""), 0);
});

test("queuedPosition: 非数组入参 → TypeError（调用方错误）", () => {
  assert.throws(() => queuedPosition(null as unknown as TaskRecord[], "x"), TypeError);
});

test("spawnAckText: 满载 position>0 → 「已排队，位置 N」；空位 → 即将开始", () => {
  const queued = spawnAckText("abc123def456", "worker", 3);
  assert.match(queued, /已排队，位置 3/);
  assert.match(queued, /abc123def456/);
  assert.match(queued, /角色=worker/);
  assert.match(queued, /farm\.done 通知到达/);
  assert.match(queued, /不得编造结果/);
  assert.match(queued, /内置 subagent 工具/);
  assert.match(queued, /farm_status abc123def456/);

  const immediate = spawnAckText("abc123def456", "", 0);
  assert.match(immediate, /即将在 WezTerm 新 pane 开始/);
  assert.doesNotMatch(immediate, /已排队/);
});

test("spawnAckText：formForced=true 附 depth-2 强制 B 形态附注；缺省 false 不含", () => {
  assert.match(spawnAckText("abc123def456", "worker", 0, true), /depth-2 任务强制 B 形态/);
  assert.doesNotMatch(spawnAckText("abc123def456", "worker", 0), /depth-2 任务强制 B 形态/);
  assert.doesNotMatch(spawnAckText("abc123def456", "", 3), /depth-2 任务强制 B 形态/);
});

// ── renderTaskDetail usage 行（票 06，FR7） ──────────────────────────────

test("renderTaskDetail usage 行：终态 + result.cost 非零 → model ↑in ↓out", () => {
  const task = makeTask({
    taskId: "t-usage",
    status: "done",
    startedAt: 1000,
    updatedAt: 5000,
    result: { sessionDir: "/s/t", exitCode: 0, cost: { model: "gpt-x", inputTokens: 12, outputTokens: 34 } },
  });
  assert.match(renderTaskDetail(task, null, 10_000), /usage: gpt-x ↑12 ↓34/);
});

test("renderTaskDetail usage 行：终态 + cost 全零/缺 → usage: —", () => {
  const zero = makeTask({
    status: "done",
    result: { sessionDir: "", exitCode: 0, cost: { model: "", inputTokens: 0, outputTokens: 0 } },
  });
  assert.match(renderTaskDetail(zero, null, 10_000), /usage: —/);
  // cost 缺省（旧记录无 cost 字段）：同样 —，不抛
  const missing = makeTask({ status: "done" });
  delete (missing.result as { cost?: unknown }).cost;
  assert.match(renderTaskDetail(missing, null, 10_000), /usage: —/);
});

test("renderTaskDetail usage 行：活态 + 注入 usage sidecar → ↑in ↓out", () => {
  const task = makeTask({ status: "running" });
  const usage = { model: "m", inputTokens: 5, outputTokens: 7, updatedAt: 1 };
  assert.match(renderTaskDetail(task, null, 10_000, usage), /usage: m ↑5 ↓7/);
});

test("renderTaskDetail usage 行：活态 + 未注入（usage undefined）→ usage: —", () => {
  const task = makeTask({ status: "running" });
  assert.match(renderTaskDetail(task, null, 10_000), /usage: —/);
});

test("renderTaskDetail：3 参与 4 参调用均不抛（可选参向后兼容）", () => {
  const task = makeTask({ status: "running" });
  // 返回 string 即隐含“调用不抛”（node:assert/strict 无 doesNotThrow）
  assert.equal(typeof renderTaskDetail(task, null, 10_000), "string");
  assert.equal(typeof renderTaskDetail(task, null, 10_000, null), "string");
  assert.equal(
    typeof renderTaskDetail(task, null, 10_000, { model: "m", inputTokens: 1, outputTokens: 2, updatedAt: 3 }),
    "string",
  );
});

// ── panelChanged（票 07 面板刷新节流，纯函数零 I/O） ───────────────────────

test("panelChanged: prev null（首拍）→ true", () => {
  assert.equal(panelChanged(null, []), true);
  assert.equal(panelChanged(null, ["a"]), true);
});

test("panelChanged: 内容相同 → false（跳过重刷）", () => {
  assert.equal(panelChanged(["a", "b"], ["a", "b"]), false);
});

test("panelChanged: 行数不同 → true", () => {
  assert.equal(panelChanged(["a"], ["a", "b"]), true);
  assert.equal(panelChanged(["a", "b"], ["a"]), true);
});

test("panelChanged: 行数同内容异 → true", () => {
  assert.equal(panelChanged(["a", "b"], ["a", "c"]), true);
  assert.equal(panelChanged(["a", "b"], ["c", "b"]), true);
});

test("panelChanged: 空→空（非首拍）→ false", () => {
  assert.equal(panelChanged([], []), false);
});

