// src/comm/inbox-integration.test.ts
// comm 读侧集成（M3 收口票 10 增补）：真 Inbox（写侧，落盘真实 inbox 文件）
// + pollInbox（读侧，真 store）+ fake sink + 可变时钟。
// 只断言外部行为：steer latest-wins（其余 supersede 记 read）、msg 全量 ts 升序、
// watermark 拒 replay（新 pending ts ≤ 已 read watermark → 停留 pending）。
// 零依赖：node:test + node: 内置 + 相对 .ts import。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../task-core/steer.ts";
import type { InboxMessage } from "../task-core/steer.ts";
import { pollInbox } from "./inbox.ts";
import type { PollSink } from "./inbox.ts";

/** 直接写 inbox 消息文件（真 store 文件格式；msgId===文件名、to===paneId）。
 *  用于造 deliver 单调递增 ts 无法产生的 replay（ts ≤ watermark）注入面。 */
async function writeMsg(
  root: string,
  paneId: string,
  msg: {
    msgId: string;
    type: "steer" | "msg";
    from: string;
    to: string;
    delivery: "notice" | "directive";
    content: string;
    status: "pending" | "delivered" | "read";
    ts: number;
  },
): Promise<void> {
  await mkdir(join(root, "inbox", paneId), { recursive: true });
  await writeFile(join(root, "inbox", paneId, `${msg.msgId}.json`), JSON.stringify(msg), "utf8");
}

async function readMsg(root: string, paneId: string, msgId: string): Promise<InboxMessage> {
  return JSON.parse(
    await readFile(join(root, "inbox", paneId, `${msgId}.json`), "utf8"),
  ) as InboxMessage;
}

test("steer latest-wins：多条 pending steer → 仅 ts 最大者送达，其余 supersede 记 read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comm-inbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new Inbox(root);
  const paneId = "pane-42";
  const s1 = await inbox.deliver({ type: "steer", from: "main", to: paneId, delivery: "directive", content: "steer-1" });
  const s2 = await inbox.deliver({ type: "steer", from: "main", to: paneId, delivery: "directive", content: "steer-2" });
  const s3 = await inbox.deliver({ type: "steer", from: "main", to: paneId, delivery: "directive", content: "steer-3" });

  const received: InboxMessage[] = [];
  const sink: PollSink = (msg) => {
    received.push(msg);
  };
  const result = await pollInbox(root, paneId, sink, { now: () => Date.now() });

  assert.equal(result.delivered.length, 1, "latest-wins：仅 1 条送达");
  assert.equal(result.superseded, 2, "其余 2 条 supersede 记 read");
  assert.equal(received.length, 1);
  assert.equal(received[0]!.msgId, s3.msgId, "送达 ts 最大者");
  assert.equal(received[0]!.content, "steer-3");
  // supersede 的两条落盘 read（status 单向推进）
  assert.equal((await readMsg(root, paneId, s1.msgId)).status, "read");
  assert.equal((await readMsg(root, paneId, s2.msgId)).status, "read");
  assert.equal((await readMsg(root, paneId, s3.msgId)).status, "read");
});

test("msg 全量按 ts 升序投递：notice 与 directive 均全量送达，无 supersede", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comm-inbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new Inbox(root);
  const paneId = "pane-7";
  const m1 = await inbox.deliver({ type: "msg", from: "main", to: paneId, delivery: "notice", content: "m-1" });
  const m2 = await inbox.deliver({ type: "msg", from: "main", to: paneId, delivery: "directive", content: "m-2" });

  const received: InboxMessage[] = [];
  const result = await pollInbox(root, paneId, (msg) => { received.push(msg); }, { now: () => Date.now() });

  assert.equal(result.delivered.length, 2, "msg 全量送达");
  assert.equal(result.superseded, 0, "msg 无 supersede");
  assert.deepEqual(
    received.map((m) => m.content),
    ["m-1", "m-2"],
    "按 ts 升序投递",
  );
  assert.equal((await readMsg(root, paneId, m1.msgId)).status, "read");
  assert.equal((await readMsg(root, paneId, m2.msgId)).status, "read");
});

test("watermark 拒 replay：已 read 消息的 ts 构成 watermark，新 pending ts≤watermark 被拒（停留 pending）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comm-inbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new Inbox(root);
  const paneId = "pane-9";

  // 第一拍：投递一条 msg 并 poll 到 read → 盘上 read 消息的 ts 成为 watermark
  const first = await inbox.deliver({ type: "msg", from: "main", to: paneId, delivery: "notice", content: "first" });
  const received: InboxMessage[] = [];
  const r1 = await pollInbox(root, paneId, (msg) => { received.push(msg); }, { now: () => Date.now() });
  assert.equal(r1.delivered.length, 1);
  const watermark = first.ts;

  // 直接写一条 ts ≤ watermark 的 pending msg（Inbox.deliver ts 单调递增，无法造 replay）
  await writeMsg(root, paneId, {
    msgId: "replay-1",
    type: "msg",
    from: "main",
    to: paneId,
    delivery: "notice",
    content: "replay",
    status: "pending",
    ts: watermark - 1,
  });

  const r2 = await pollInbox(root, paneId, (msg) => { received.push(msg); }, { now: () => Date.now() });
  assert.equal(r2.delivered.length, 0, "replay 不送达");
  assert.equal(r2.skipped, 1, "replay 计 skipped");
  assert.equal(received.length, 1, "sink 仍只有 first");
  // replay 停留 pending（at-most-once 不误删，由 24h GC 回收）
  assert.equal((await readMsg(root, paneId, "replay-1")).status, "pending");
});
