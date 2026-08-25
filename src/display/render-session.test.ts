// src/display/render-session.test.ts
// 票 04 渲染器会话单测（render-core.test.ts 拆分产物）：RenderSession 逐事件断言
// （spike m25-a2-full 证据重放 / queue_update / response / message_end 权威校正 /
// thinking / 工具错误 / 环形缓冲）。session 全纯，零 I/O、不 spawn 真 pi。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RenderSession } from "./session.ts";
import { MAX_LINE_CHARS, RING_BYTE_BUDGET } from "./primitives.ts";

const TASK_ID = "019ffbb9-f298-7e6d-9b56-a2dd1ce2751d";
const TASK_ID8 = TASK_ID.slice(0, 8);

function ev(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...fields });
}

function msgStart(role: string, text: string): string {
  return ev("message_start", {
    message: { role, content: text === "" ? [] : [{ type: "text", text }] },
  });
}

function msgEnd(role: string, text: string, usage?: unknown): string {
  const message: Record<string, unknown> = { role, content: [{ type: "text", text }] };
  if (usage !== undefined) message["usage"] = usage;
  return ev("message_end", { message });
}

function delta(kind: string, d: string): string {
  return ev("message_update", { assistantMessageEvent: { type: kind, contentIndex: 0, delta: d } });
}

function textEnd(content: string): string {
  return ev("message_update", { assistantMessageEvent: { type: "text_end", contentIndex: 0, content } });
}

function toolStart(name: string, args: unknown): string {
  return ev("tool_execution_start", { toolCallId: "call_1", toolName: name, args });
}

function toolUpdate(name: string, partialResult: unknown): string {
  return ev("tool_execution_update", { toolCallId: "call_1", toolName: name, partialResult });
}

function toolEnd(name: string, result: unknown, isError: boolean): string {
  return ev("tool_execution_end", { toolCallId: "call_1", toolName: name, result, isError });
}

function queue(steering: unknown): string {
  return ev("queue_update", { steering, followUp: [] });
}

/** spike §S1/§S3 证据原文（m25-a2-full） */
const PROMPT =
  "Use the bash tool to run this single command exactly: `sleep 8 && echo WAKE`. Do not run any other command. After it finishes, reply with exactly the word DONE and nothing else.";
const STEER1 =
  "After the sleep command finishes, do not reply DONE. Reply with exactly the word STEERED-ONE and nothing else.";
const STEER2 =
  "After the sleep command finishes, do not reply DONE or STEERED-ONE. Reply with exactly the word STEERED-TWO and nothing else.";
const USAGE_4698 = { input: 85, output: 5, cacheRead: 4608, cacheWrite: 0, reasoning: 0, totalTokens: 4698 };
const USAGE_4739 = { input: 126, output: 5, cacheRead: 4608, cacheWrite: 0, reasoning: 0, totalTokens: 4739 };

/** spike §S4 时间线（events.log 节选）：prompt 回合 → 工具 → steer 送达 ×2 → 收尾。 */
function a2FullFixture(): string[] {
  return [
    ev("agent_start"),
    ev("turn_start"),
    msgStart("user", PROMPT),
    msgEnd("user", PROMPT),
    msgStart("assistant", ""),
    delta("toolcall_start", ""),
    delta("toolcall_delta", "{\""),
    delta("toolcall_delta", "command"),
    toolStart("bash", { command: "sleep 8 && echo WAKE" }),
    queue([STEER1]),
    toolUpdate("bash", { content: [] }),
    queue([STEER1, STEER2]),
    toolUpdate("bash", { content: [{ type: "text", text: "WAKE\n" }], details: {} }),
    queue([STEER2]),
    toolEnd("bash", { content: [{ type: "text", text: "WAKE\n" }] }, false),
    ev("turn_end", { message: { role: "assistant", usage: { totalTokens: 4652 } }, toolResults: [] }),
    ev("turn_start"),
    queue([]),
    msgStart("user", STEER1),
    msgEnd("user", STEER1),
    msgStart("assistant", ""),
    delta("text_start", ""),
    delta("text_delta", "STE"),
    delta("text_delta", "ER"),
    delta("text_delta", "ED"),
    delta("text_delta", "-"),
    delta("text_delta", "ONE"),
    textEnd("STEERED-ONE"),
    msgEnd("assistant", "STEERED-ONE", USAGE_4698),
    ev("turn_end", { message: { role: "assistant", usage: USAGE_4698 }, toolResults: [] }),
    ev("turn_start"),
    queue([]),
    msgStart("user", STEER2),
    msgEnd("user", STEER2),
    msgStart("assistant", ""),
    delta("text_start", ""),
    delta("text_delta", "STE"),
    delta("text_delta", "ER"),
    delta("text_delta", "ED"),
    delta("text_delta", "-T"),
    delta("text_delta", "WO"),
    textEnd("STEERED-TWO"),
    msgEnd("assistant", "STEERED-TWO", USAGE_4739),
    ev("turn_end", { message: { role: "assistant", usage: USAGE_4739 }, toolResults: [] }),
    ev("agent_end", { messages: [], willRetry: false }),
    ev("agent_settled"),
    queue(["Reply with exactly the word IDLE-REPLY and nothing else."]),
  ];
}

function newSession(prompt: string = PROMPT): RenderSession {
  return new RenderSession({
    taskId: TASK_ID,
    role: "worker",
    prompt,
    startedAt: 0,
    now: () => 1_000_000,
  });
}

function lineTexts(s: RenderSession): string[] {
  return s.getLines().map((l) => l.text);
}
test("spike 证据重放：工具摘要/steer 送达/回合/usage/生命周期逐事件断言", () => {
  const s = newSession();
  for (const line of a2FullFixture()) s.consumeLine(line);

  const lines = lineTexts(s);
  assert.ok(lines.includes("── 回合 1 ──"));
  assert.ok(lines.includes("── 回合 2 ──"));
  assert.ok(lines.includes("── 回合 3 ──"));
  assert.ok(lines.includes("🔧 bash: sleep 8 && echo WAKE"));
  assert.ok(lines.includes("✓ bash 完成: WAKE"));
  assert.ok(lines.includes("STEERED-ONE"));
  assert.ok(lines.includes("STEERED-TWO"));
  assert.ok(lines.includes(`👤 ${STEER1}`)); // steer 以 user 消息入流回显（spike §S4）
  assert.ok(lines.includes(`👤 ${STEER2}`));
  assert.ok(lines.includes("▶ agent 回合结束"));
  assert.ok(lines.includes("▶ 已结束（agent_settled）"));
  // 首条 user message（注入 prompt 全文）跳过回显——只有首屏预览
  assert.ok(!lines.includes(`👤 ${PROMPT}`));
  assert.ok(lines.some((l) => l.startsWith("📋 ")));
  // 无 ANSI 泄漏
  for (const l of lines) assert.ok(!l.includes("\x1b"), `行含 ESC: ${JSON.stringify(l)}`);

  const st = s.getStatus();
  assert.equal(st.turn, 3);
  assert.equal(st.totalTokens, 4739); // usage 从 message 字段提取（最后一条权威）
  assert.equal(st.steerQueued, 1); // 尾部空闲 steer 滞留（spike §Q4）
  assert.equal(st.phase, "已结束");
  assert.equal(s.settled, true);
  assert.equal(st.label, "运行中"); // farm 状态标签恒「运行中」
  assert.equal(st.taskId8, TASK_ID8);
  assert.equal(st.elapsedMs, 0); // now 注入 1_000_000 = 锚定 bootAt
});
test("queue_update 排队态逐步断言 + 形状容错（spike §Q）", () => {
  const s = newSession();
  s.consumeLine(queue([STEER1]));
  assert.equal(s.getStatus().steerQueued, 1);
  s.consumeLine(queue([STEER1, STEER2]));
  assert.equal(s.getStatus().steerQueued, 2);
  s.consumeLine(queue([STEER2]));
  assert.equal(s.getStatus().steerQueued, 1);
  s.consumeLine(queue([]));
  assert.equal(s.getStatus().steerQueued, 0); // 队列清空 = 徽标熄灭
  // 容错：缺失/非数组/非字符串元素
  s.consumeLine(ev("queue_update", {}));
  assert.equal(s.getStatus().steerQueued, 0);
  s.consumeLine(ev("queue_update", { steering: "oops", followUp: [] }));
  assert.equal(s.getStatus().steerQueued, 0);
  s.consumeLine(ev("queue_update", { steering: [1, "a", null, "b"], followUp: 42 }));
  assert.equal(s.getStatus().steerQueued, 2);
});
test("response 事件：steer 成败态（票 05）—— success:true 清拒态 / false 置拒态 / 容错", () => {
  const s = newSession();
  // success:true → 拒态 null
  s.consumeLine(ev("response", { command: "steer", success: true }));
  assert.equal(s.getStatus().steerRejected, null);
  // success:false + error → 附原因
  s.consumeLine(ev("response", { command: "steer", success: false, error: "EPIPE" }));
  assert.equal(s.getStatus().steerRejected, "EPIPE");
  // success:false 缺 error → 通用文案
  s.consumeLine(ev("response", { command: "steer", success: false }));
  assert.equal(s.getStatus().steerRejected, "（未给原因）");
  // success 非 boolean → 忽略（保持上一条）
  s.consumeLine(ev("response", { command: "steer", success: "yes" }));
  assert.equal(s.getStatus().steerRejected, "（未给原因）");
  // 未知 command（get_state 等）→ 忽略
  s.consumeLine(ev("response", { command: "get_state", success: false, error: "x" }));
  assert.equal(s.getStatus().steerRejected, "（未给原因）");
  // clearSteerFeedback：新一轮提交清 stale 拒态
  s.clearSteerFeedback();
  assert.equal(s.getStatus().steerRejected, null);
});
test("steer 乐观瞬态：setSteerSent → queue_update 清除（票 06 追加）", () => {
  const s = newSession();
  s.setSteerSent();
  assert.equal(s.getStatus().steerSent, true);
  s.consumeLine(queue([STEER1]));
  assert.equal(s.getStatus().steerSent, false);
  assert.equal(s.getStatus().steerQueued, 1);
});
test("坏行/巨行/未知事件/无 type 对象注入不崩", () => {
  const s = newSession();
  s.consumeLine("this is not json");
  s.consumeLine("123");
  s.consumeLine("{}");
  s.consumeLine('{"type":"future_event","x":1}');
  s.consumeLine('{"no_type":true}');
  s.consume("x".repeat(MAX_LINE_CHARS + 5) + "\n");
  const st = s.getStatus();
  assert.equal(st.badLines, 3); // not-json + 123 + 巨行截断后 parse 败
  assert.equal(st.oversizeLines, 1);
  assert.equal(s.getLines().length, 3); // 仅首屏 3 行
});
test("message_end 权威校正：delta 缺失尾部由权威续拼", () => {
  const s = newSession("P");
  s.consumeLine(msgStart("assistant", ""));
  s.consumeLine(delta("text_delta", "HELL"));
  // 权威内容长于已收到 delta：续拼剩余
  s.consumeLine(msgEnd("assistant", "HELLO WORLD", USAGE_4698));
  const lines = lineTexts(s);
  assert.ok(lines.includes("HELLO WORLD"));
  assert.equal(s.getStatus().totalTokens, 4698);
});
test("message_end 权威校正：deltas 超发时丢弃未 flush 尾部（append-only 不可回退）", () => {
  const s = newSession("P");
  s.consumeLine(msgStart("assistant", ""));
  s.consumeLine(delta("text_delta", "HELLO WORLD\n")); // 换行触发 flush 上屏
  s.consumeLine(msgEnd("assistant", "HELL"));
  assert.ok(lineTexts(s).includes("HELLO WORLD")); // 已 flush 上屏不可回退
  // 后续事件不受污染
  s.consumeLine(delta("text_delta", "x"));
  s.consumeLine(msgEnd("assistant", "HELLx"));
  assert.ok(lineTexts(s).includes("x"));
});
test("ANSI 跨 delta 劈开 + message_end 权威校正组合（组装后文本层剥除）", () => {
  const s = newSession("P");
  s.consumeLine(msgStart("assistant", ""));
  s.consumeLine(delta("text_delta", "\x1b[3"));
  s.consumeLine(delta("text_delta", "1mCOLOR\x1b[0m"));
  s.consumeLine(delta("text_delta", " plain"));
  // 权威内容 = 原始文本（含转义序列），与 delta 原始空间长度一致
  s.consumeLine(msgEnd("assistant", "\x1b[31mCOLOR\x1b[0m plain"));
  const lines = lineTexts(s);
  assert.ok(lines.includes("COLOR plain"));
  for (const l of lines) assert.ok(!l.includes("\x1b"));
});
test("message_end 权威校正：多文本块消息非首块不丢字（评审 R#2 回归）", () => {
  const s = newSession("P");
  // 多块消息：[text "A", toolCall, text "BBBBBBBBBB"]——非首块长于首块，旧实现
  // text_end 块级权威校正会误清非首块文本（永久丢字）。
  const multiBlockContent = [
    { type: "text", text: "A" },
    { type: "toolCall", id: "tc1", name: "bash", args: {} },
    { type: "text", text: "BBBBBBBBBB" },
  ];
  s.consumeLine(ev("message_start", { message: { role: "assistant", content: multiBlockContent } }));
  // 块 0：text "A"
  s.consumeLine(ev("message_update", { assistantMessageEvent: { type: "text_start", contentIndex: 0 } }));
  s.consumeLine(ev("message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "A" } }));
  s.consumeLine(ev("message_update", { assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "A" } }));
  // 块 1：toolCall（不显示）
  s.consumeLine(ev("message_update", { assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } }));
  s.consumeLine(ev("message_update", { assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{}" } }));
  s.consumeLine(ev("message_update", { assistantMessageEvent: { type: "toolcall_end", contentIndex: 1 } }));
  // 块 2：text "BBBBBBBBBB"（非首块，长于首块）
  s.consumeLine(ev("message_update", { assistantMessageEvent: { type: "text_start", contentIndex: 2 } }));
  s.consumeLine(ev("message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "BBBBBBBBBB" } }));
  s.consumeLine(ev("message_update", { assistantMessageEvent: { type: "text_end", contentIndex: 2, content: "BBBBBBBBBB" } }));
  s.consumeLine(ev("message_end", { message: { role: "assistant", content: multiBlockContent } }));
  const lines = lineTexts(s);
  assert.ok(lines.includes("A"), "首块文本保留");
  assert.ok(lines.includes("BBBBBBBBBB"), "非首块文本不丢（R#2 误清回归）");
});
test("thinking delta 组装 + 阶段标记 + text_start 边界 flush", () => {
  const s = newSession("P");
  s.consumeLine(msgStart("assistant", ""));
  s.consumeLine(delta("thinking_start", ""));
  assert.equal(s.getStatus().phase, "思考中");
  s.consumeLine(delta("thinking_delta", "The"));
  s.consumeLine(delta("thinking_delta", " user"));
  s.consumeLine(delta("thinking_end", ""));
  assert.ok(lineTexts(s).includes("The user"));
  s.consumeLine(delta("text_start", ""));
  assert.equal(s.getStatus().phase, "写回");
  s.consumeLine(delta("text_delta", "REPLY"));
  s.consumeLine(msgEnd("assistant", "REPLY"));
  assert.ok(lineTexts(s).includes("REPLY"));
});
test("多行 delta 拆行 + 空行保留", () => {
  const s = newSession("P");
  s.consumeLine(msgStart("assistant", ""));
  s.consumeLine(delta("text_delta", "line1\nline2\n"));
  const lines = lineTexts(s);
  assert.ok(lines.includes("line1"));
  assert.ok(lines.includes("line2"));
});
test("tool_execution_end isError：✗ 失败 文字标记 + tool-error 行（a11y frontend#7）", () => {
  const s = newSession("P");
  s.consumeLine(toolStart("write", { filePath: "/tmp/x" }));
  s.consumeLine(toolEnd("write", { content: [{ type: "text", text: "EACCES: permission denied" }] }, true));
  const errLine = s.getLines().find((l) => l.kind === "tool-error");
  assert.ok(errLine);
  assert.match(errLine.text, /^✗ 失败 write: EACCES/);
  assert.equal(s.getStatus().phase, "工具失败: write");
});
test("tool_execution_update 仅错误显示：isError 标记 / error 字段 / 正常更新静默", () => {
  const s = newSession("P");
  s.consumeLine(toolUpdate("bash", { content: [{ type: "text", text: "ok output" }] }));
  assert.ok(!lineTexts(s).some((l) => l.includes("ok output"))); // 正常 partial 静默
  s.consumeLine(toolUpdate("bash", { content: [{ type: "text", text: "boom" }], isError: true }));
  assert.ok(s.getLines().some((l) => l.kind === "tool-error" && l.text.includes("boom")));
  s.consumeLine(toolUpdate("bash", { error: "EPERM" }));
  assert.ok(s.getLines().some((l) => l.kind === "tool-error" && l.text.includes("EPERM")));
});
test("session header：cwd 进状态条 + version≠3 容忍", () => {
  const s = newSession();
  s.consumeLine('{"type":"session","version":99,"id":"x","timestamp":"t","cwd":"/tmp/proj"}');
  assert.equal(s.getStatus().cwd, "/tmp/proj");
});
test("环形缓冲：500 逻辑行封顶 + …(省略 N 行) 标记", () => {
  const s = newSession();
  for (let i = 0; i < 600; i++) s.consumeLine(ev("agent_start"));
  assert.equal(s.getLines().length, 500);
  assert.ok(s.getOmitted() > 0);
  const visible = s.renderVisible(80, 10);
  assert.match(visible[0]!.text, /^…\(省略 \d+ 行\)$/);
});
test("环形缓冲：8MiB 总量预算封顶（巨行驱逐）", () => {
  const s = newSession("P");
  const big = "x".repeat(900 * 1024);
  for (let i = 0; i < 10; i++) {
    s.consumeLine(msgStart("assistant", ""));
    s.consumeLine(delta("text_delta", big));
    s.consumeLine(msgEnd("assistant", big));
  }
  assert.ok(s.getOmitted() >= 1); // 预算溢出发生驱逐
  const lines = s.getLines();
  assert.ok(lines.length <= 9); // 首屏 3 行 + 900KiB 行，8MiB 预算内
  let total = 0;
  for (const l of lines) total += utf8Len(l.text);
  assert.ok(total <= RING_BYTE_BUDGET);
});
/** 测试用 UTF-8 长度（与 render-core 内部估算同口径；不引 @types） */
function utf8Len(text: string): number {
  let bytes = 0;
  for (const cp of text) {
    const c = cp.codePointAt(0)!;
    if (c <= 0x7f) bytes += 1;
    else if (c <= 0x7ff) bytes += 2;
    else if (c <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
