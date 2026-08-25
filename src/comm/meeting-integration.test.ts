// src/comm/meeting-integration.test.ts
// main 收件接线集成（票 03）：meetingSink（recordReply 记活跃轮 + buildSteerSink 投递）
// 与真 Inbox（写侧落盘）+ pollInbox（读侧）+ fake pi.sendMessage 组合，只断言外部行为：
//   T1 notice：deliverAs followUp（无 triggerTurn）+ replies 记录 + status read；
//   T2 directive：deliverAs steer + triggerTurn；
//   T3 无活跃轮：不抛、round 恒 null、bubble 仍送达。
// meetingSink 在 index.ts 中 inline 装配（主板裁定不抽 steer-tool 纯函数），本测试
// 以同一 wrap 表达式复现装配（与 index.ts 同一来源的 buildSteerSink/recordReply/
// getActiveRound），锁定集成契约；零 pi SDK import，归 node --test 直接跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../task-core/steer.ts";
import type { InboxMessage } from "../task-core/steer.ts";
import { pollInbox } from "./inbox.ts";
import type { PollSink } from "./inbox.ts";
import { buildSteerSink } from "../steer-tool.ts";
import { getActiveRound, openRound, recordReply, setActiveRound } from "./meeting.ts";

/** fake pi：记录 sendMessage(message, options) 调用，供断言 deliverAs/triggerTurn。 */
interface CapturedSend {
  message: Record<string, unknown>;
  options: Record<string, unknown>;
}

function makePi(): { calls: CapturedSend[]; sendMessage: (m: unknown, o?: unknown) => void } {
  const calls: CapturedSend[] = [];
  return {
    calls,
    sendMessage(message: unknown, options?: unknown) {
      calls.push({
        message: message as Record<string, unknown>,
        options: (options ?? {}) as Record<string, unknown>,
      });
    },
  };
}

/** 与 index.ts 内 inline meetingSink 同一 wrap 表达式（装配契约复现，非抽取纯函数）。 */
function meetingSink(pi: { sendMessage: (m: unknown, o?: unknown) => void }): PollSink {
  return (msg) => {
    recordReply(getActiveRound(), msg.from, msg.content);
    return buildSteerSink(pi)(msg);
  };
}

/** 读 inbox 落盘消息（真 store 文件格式），断言 status 已推进。 */
async function readMsg(root: string, msgId: string): Promise<InboxMessage> {
  return JSON.parse(
    await readFile(join(root, "inbox", "main", `${msgId}.json`), "utf8"),
  ) as InboxMessage;
}

test("T1 notice：deliverAs followUp（无 triggerTurn）+ replies 记录 + status read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "meeting-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new Inbox(root);
  const pi = makePi();

  // 开活跃轮：受邀 pane-a，其回复应记入 replies
  setActiveRound(openRound(["pane-a"], 0));

  const delivered = await inbox.deliver({
    type: "msg",
    from: "pane-a",
    to: "main",
    delivery: "notice",
    content: "同意方案 B",
  });

  const result = await pollInbox(root, "main", meetingSink(pi), { now: () => Date.now() });

  // status read：pollInbox 已推进到 read 并落盘
  assert.equal(result.delivered.length, 1);
  assert.equal(result.delivered[0]!.status, "read");
  assert.equal((await readMsg(root, delivered.msgId)).status, "read");

  // notice → followUp，无 triggerTurn
  assert.equal(pi.calls.length, 1);
  assert.deepEqual(pi.calls[0]!.options, { deliverAs: "followUp" });
  assert.equal(pi.calls[0]!.message["customType"], "farm.msg.notice");
  assert.equal(pi.calls[0]!.message["display"], true);

  // replies 记录：pane-a → content（首条 wins）
  const round = getActiveRound();
  assert.ok(round !== null);
  assert.equal(round!.replies.get("pane-a"), "同意方案 B");
  assert.equal(round!.replies.size, 1);

  setActiveRound(null); // 清理模块级 holder
});

test("T2 directive：deliverAs steer + triggerTurn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "meeting-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new Inbox(root);
  const pi = makePi();

  setActiveRound(openRound(["pane-a"], 0));

  const delivered = await inbox.deliver({
    type: "msg",
    from: "pane-a",
    to: "main",
    delivery: "directive",
    content: "请执行指令",
  });

  const result = await pollInbox(root, "main", meetingSink(pi), { now: () => Date.now() });

  assert.equal(result.delivered.length, 1);
  assert.equal((await readMsg(root, delivered.msgId)).status, "read");

  // directive → steer + triggerTurn:true
  assert.equal(pi.calls.length, 1);
  assert.deepEqual(pi.calls[0]!.options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(pi.calls[0]!.message["customType"], "farm.msg.directive");

  // replies 同样记入（directive 也是 agent 回复）
  const round = getActiveRound();
  assert.equal(round!.replies.get("pane-a"), "请执行指令");

  setActiveRound(null);
});

test("T3 无活跃轮：不抛、round 恒 null、bubble 仍送达", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "meeting-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new Inbox(root);
  const pi = makePi();

  // 无活跃轮（票 03 单独合入时 getActiveRound() === null）
  setActiveRound(null);
  assert.equal(getActiveRound(), null);

  const delivered = await inbox.deliver({
    type: "msg",
    from: "pane-a",
    to: "main",
    delivery: "notice",
    content: "无轮时的回复",
  });

  // 不抛即通过；recordReply(null, …) 容错 no-op
  const result = await pollInbox(root, "main", meetingSink(pi), { now: () => Date.now() });

  assert.equal(getActiveRound(), null, "round 恒 null");
  assert.equal(result.delivered.length, 1, "bubble 仍送达");
  assert.equal((await readMsg(root, delivered.msgId)).status, "read");
  assert.equal(pi.calls.length, 1);
  assert.deepEqual(pi.calls[0]!.options, { deliverAs: "followUp" });

  setActiveRound(null);
});
