// src/comm/inbox.test.ts
// pollInbox + readInboxSnapshot 用例（票 01 plan §5.1 清单全覆盖）。
// 只断言外部行为（sink 调用序/三态落盘/PollResult 计数/零副作用），不测内部实现。
// inbox 根目录用 fs.mkdtemp 注入，测试互不串扰。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollInbox, readInboxSnapshot, type PollSink } from "./inbox.ts";
import type { InboxMessage } from "../task-core/steer.ts";

const PANE = "pane-1";

async function makeRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "comm-inbox-"));
}

function msg(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    msgId: "m",
    type: "steer",
    from: "main",
    to: PANE,
    delivery: "directive",
    content: "",
    status: "pending",
    ts: 0,
    ...over,
  };
}

async function writeMsg(root: string, m: InboxMessage): Promise<void> {
  const dir = join(root, "inbox", m.to);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${m.msgId}.json`), JSON.stringify(m), "utf8");
}

async function readMsgOnDisk(root: string, to: string, msgId: string): Promise<InboxMessage> {
  const raw: string = await readFile(join(root, "inbox", to, `${msgId}.json`), "utf8");
  return JSON.parse(raw) as InboxMessage;
}

/** 记录 sink：先记录后（可选）抛错，模拟失败消息仍被「交一次」。 */
function recordingSink(
  received: InboxMessage[],
  failOn?: (m: InboxMessage) => boolean,
): PollSink {
  return (m) => {
    received.push(m);
    if (failOn && failOn(m)) throw new Error(`sink failure on ${m.msgId}`);
  };
}

test("steer latest-wins：3 条 pending steer 只投 ts 最大 1 条，其余 supersede 记 read", async () => {
  const root = await makeRoot();
  await writeMsg(root, msg({ msgId: "s1", ts: 1 }));
  await writeMsg(root, msg({ msgId: "s2", ts: 2 }));
  await writeMsg(root, msg({ msgId: "s3", ts: 3 }));

  const received: InboxMessage[] = [];
  const result = await pollInbox(root, PANE, recordingSink(received));

  assert.deepEqual(received.map((m) => m.msgId), ["s3"]);
  assert.equal(result.superseded, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.sinkFailed, 0);
  assert.equal(result.delivered.length, 1);
  assert.equal(result.delivered[0].msgId, "s3");
  assert.equal(result.delivered[0].status, "read");
  // 落盘：s3 read、s1/s2 supersede 记 read
  assert.equal((await readMsgOnDisk(root, PANE, "s1")).status, "read");
  assert.equal((await readMsgOnDisk(root, PANE, "s2")).status, "read");
  assert.equal((await readMsgOnDisk(root, PANE, "s3")).status, "read");
});

test("msg 全量升序：3 条 pending msg（ts 乱序）按 ts 升序全投、全 read", async () => {
  const root = await makeRoot();
  await writeMsg(root, msg({ msgId: "m3", type: "msg", ts: 3 }));
  await writeMsg(root, msg({ msgId: "m1", type: "msg", ts: 1 }));
  await writeMsg(root, msg({ msgId: "m2", type: "msg", ts: 2 }));

  const received: InboxMessage[] = [];
  const result = await pollInbox(root, PANE, recordingSink(received));

  assert.deepEqual(received.map((m) => m.msgId), ["m1", "m2", "m3"]);
  assert.equal(result.delivered.length, 3);
  assert.equal(result.superseded, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.sinkFailed, 0);
  for (const id of ["m1", "m2", "m3"]) {
    assert.equal((await readMsgOnDisk(root, PANE, id)).status, "read");
  }
});

test("watermark 拒 replay：ts ≤ 已 read 最大 ts 的 pending 被 skipped、sink 不调、保持 pending", async () => {
  const root = await makeRoot();
  // 已 read 消息（ts=100）作 watermark
  await writeMsg(root, msg({ msgId: "old", ts: 100, status: "read" }));
  // 更早的 pending（ts=50）→ replay 拒
  await writeMsg(root, msg({ msgId: "replay", ts: 50, status: "pending" }));

  const received: InboxMessage[] = [];
  const result = await pollInbox(root, PANE, recordingSink(received));

  assert.equal(received.length, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.delivered.length, 0);
  assert.equal(result.superseded, 0);
  // 拒 replay 后仍保持 pending（由 24h GC 回收）
  assert.equal((await readMsgOnDisk(root, PANE, "replay")).status, "pending");
});

test("60s 兜底（首读）：mtime 陈旧拒、新鲜收", async () => {
  const root = await makeRoot();
  const now = 1_700_000_000_000;
  await writeMsg(root, msg({ msgId: "stale", ts: 1 }));
  await writeMsg(root, msg({ msgId: "fresh", ts: 2 }));
  const dir = join(root, "inbox", PANE);
  await utimes(join(dir, "stale.json"), new Date(now - 61_000), new Date(now - 61_000));
  await utimes(join(dir, "fresh.json"), new Date(now - 10_000), new Date(now - 10_000));

  const received: InboxMessage[] = [];
  const result = await pollInbox(root, PANE, recordingSink(received), { now: () => now });

  assert.deepEqual(received.map((m) => m.msgId), ["fresh"]);
  assert.equal(result.skipped, 1);
  assert.equal(result.delivered.length, 1);
  // 陈旧 pending 不 advance（保持 pending）
  assert.equal((await readMsgOnDisk(root, PANE, "stale")).status, "pending");
});

test("坏 JSON 跳过：skipped=1、不崩、sink 不调", async () => {
  const root = await makeRoot();
  const dir = join(root, "inbox", PANE);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "x.json"), "oops", "utf8");

  const received: InboxMessage[] = [];
  const result = await pollInbox(root, PANE, recordingSink(received));

  assert.equal(result.skipped, 1);
  assert.equal(received.length, 0);
  assert.equal(result.delivered.length, 0);
});

test("路径逃逸/畸形 msgId 跳过：msgId 为 .. 或与 parsed.msgId 不符 → skipped", async () => {
  const root = await makeRoot();
  const dir = join(root, "inbox", PANE);
  await mkdir(dir, { recursive: true });
  // 文件名派生 msgId = ".."（逃逸）
  await writeFile(join(dir, "...json"), JSON.stringify(msg({ msgId: ".." })), "utf8");
  // parsed.msgId 与文件名派生不符
  await writeFile(
    join(dir, "evil.json"),
    JSON.stringify(msg({ msgId: "different" })),
    "utf8",
  );

  const received: InboxMessage[] = [];
  const result = await pollInbox(root, PANE, recordingSink(received));

  assert.equal(result.skipped, 2);
  assert.equal(received.length, 0);
});

test("parsed.to !== 目录 paneId → skipped（sink 不调、不 advance）", async () => {
  const root = await makeRoot();
  const dir = join(root, "inbox", PANE);
  await mkdir(dir, { recursive: true });
  // 文件落在 inbox/<PANE>/，但 parsed.to 指向别的 pane → 身份字段不符
  await writeFile(
    join(dir, "mismatch.json"),
    JSON.stringify(msg({ msgId: "mismatch", to: "other-pane" })),
    "utf8",
  );

  const received: InboxMessage[] = [];
  const result = await pollInbox(root, PANE, recordingSink(received));

  assert.equal(result.skipped, 1);
  assert.equal(received.length, 0);
  assert.equal(result.delivered.length, 0);
  // 不 advance：保持 pending
  const raw = JSON.parse(await readFile(join(dir, "mismatch.json"), "utf8")) as InboxMessage;
  assert.equal(raw.status, "pending");
});

test("advance 推进断言：poll 后三态（成功 read / sink 失败 delivered / superseded read）", async () => {
  const root = await makeRoot();
  await writeMsg(root, msg({ msgId: "a", ts: 1 }));
  await writeMsg(root, msg({ msgId: "b", ts: 2 }));
  await writeMsg(root, msg({ msgId: "c", ts: 3 }));

  const received: InboxMessage[] = [];
  // sink 只对最新 steer（ts=3）抛错
  const result = await pollInbox(root, PANE, recordingSink(received, (m) => m.msgId === "c"));

  assert.equal(result.superseded, 2);
  assert.equal(result.sinkFailed, 1);
  assert.equal(result.delivered.length, 0);
  // a/b superseded → read；c sink 失败 → 停留 delivered
  assert.equal((await readMsgOnDisk(root, PANE, "a")).status, "read");
  assert.equal((await readMsgOnDisk(root, PANE, "b")).status, "read");
  assert.equal((await readMsgOnDisk(root, PANE, "c")).status, "delivered");
});

test("sink 抛错不崩：第 1 条失败、2/3 条照常投递；sinkFailed=1；第 1 条停留 delivered", async () => {
  const root = await makeRoot();
  await writeMsg(root, msg({ msgId: "m1", type: "msg", ts: 1 }));
  await writeMsg(root, msg({ msgId: "m2", type: "msg", ts: 2 }));
  await writeMsg(root, msg({ msgId: "m3", type: "msg", ts: 3 }));

  const received: InboxMessage[] = [];
  const result = await pollInbox(root, PANE, recordingSink(received, (m) => m.msgId === "m1"));

  // 三条都被交过（第 1 条抛错），2/3 成功 read
  assert.deepEqual(received.map((m) => m.msgId), ["m1", "m2", "m3"]);
  assert.equal(result.sinkFailed, 1);
  assert.equal(result.delivered.map((m) => m.msgId).join(","), "m2,m3");
  assert.equal((await readMsgOnDisk(root, PANE, "m1")).status, "delivered");
  assert.equal((await readMsgOnDisk(root, PANE, "m2")).status, "read");
  assert.equal((await readMsgOnDisk(root, PANE, "m3")).status, "read");
});

test("非 .json / tmp 忽略：.foo.tmp、bar.txt 不读不计数", async () => {
  const root = await makeRoot();
  const dir = join(root, "inbox", PANE);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".foo.tmp"), "x", "utf8");
  await writeFile(join(dir, "bar.txt"), "x", "utf8");
  await writeMsg(root, msg({ msgId: "ok", type: "msg", ts: 1 }));

  const received: InboxMessage[] = [];
  const result = await pollInbox(root, PANE, recordingSink(received));

  assert.deepEqual(received.map((m) => m.msgId), ["ok"]);
  assert.equal(result.skipped, 0);
  assert.equal(result.delivered.length, 1);
});

test("空/不存在目录：返回空结果不崩", async () => {
  const root = await makeRoot(); // 无 inbox 目录
  const received: InboxMessage[] = [];
  const result = await pollInbox(root, PANE, recordingSink(received));
  assert.deepEqual(result, { delivered: [], superseded: 0, skipped: 0, sinkFailed: 0 });
  assert.equal(received.length, 0);
});

test("非法 paneId：路径逃逸直接返回空结果（不崩、不落盘）", async () => {
  const root = await makeRoot();
  const received: InboxMessage[] = [];
  const result = await pollInbox(root, "../evil", recordingSink(received));
  assert.deepEqual(result, { delivered: [], superseded: 0, skipped: 0, sinkFailed: 0 });
  assert.deepEqual(await readdir(root), []);
});

test("steer+msg 混排：一次 poll 中 steer 先于 msg（directive 优先级）", async () => {
  const root = await makeRoot();
  await writeMsg(root, msg({ msgId: "m1", type: "msg", ts: 1 }));
  await writeMsg(root, msg({ msgId: "s", type: "steer", ts: 5 }));
  await writeMsg(root, msg({ msgId: "m2", type: "msg", ts: 2 }));

  const received: InboxMessage[] = [];
  await pollInbox(root, PANE, recordingSink(received));

  assert.deepEqual(
    received.map((m) => `${m.type}:${m.ts}`),
    ["steer:5", "msg:1", "msg:2"],
  );
});

test("readInboxSnapshot：全合法消息确定性排序、坏文件跳过、零副作用不 advance", async () => {
  const root = await makeRoot();
  const dir = join(root, "inbox", PANE);
  await mkdir(dir, { recursive: true });
  await writeMsg(root, msg({ msgId: "b", type: "msg", ts: 2 }));
  await writeMsg(root, msg({ msgId: "c", type: "msg", ts: 3 }));
  await writeMsg(root, msg({ msgId: "a", type: "msg", ts: 1, status: "read" }));
  await writeFile(join(dir, "bad.json"), "oops", "utf8");
  await writeFile(join(dir, "note.txt"), "x", "utf8");
  await writeFile(join(dir, ".tmp"), "x", "utf8");

  const snapshot = await readInboxSnapshot(root, PANE);

  assert.deepEqual(snapshot.map((m) => m.msgId), ["a", "b", "c"]);
  assert.deepEqual(snapshot.map((m) => m.ts), [1, 2, 3]);
  // 零副作用：read 的仍是 read、pending 仍是 pending
  assert.equal((await readMsgOnDisk(root, PANE, "a")).status, "read");
  assert.equal((await readMsgOnDisk(root, PANE, "b")).status, "pending");
  assert.equal((await readMsgOnDisk(root, PANE, "c")).status, "pending");
});

test("at-most-once 跨轮：sink 抛错后消息停留 delivered、下一轮 poll 不重投", async () => {
  const root = await makeRoot();
  await writeMsg(root, msg({ msgId: "m1", type: "msg", ts: 1 }));

  // 第一轮：sink 抛错 → sinkFailed=1、停留 delivered（已交 sink 一次）
  const received1: InboxMessage[] = [];
  const first = await pollInbox(root, PANE, recordingSink(received1, () => true));
  assert.deepEqual(received1.map((m) => m.msgId), ["m1"]);
  assert.equal(first.sinkFailed, 1);
  assert.equal(first.delivered.length, 0);
  assert.equal((await readMsgOnDisk(root, PANE, "m1")).status, "delivered");

  // 第二轮：delivered 非 pending，不进投递候选 → sink 不调、不重投
  const received2: InboxMessage[] = [];
  const second = await pollInbox(root, PANE, recordingSink(received2));
  assert.equal(received2.length, 0);
  assert.equal(second.delivered.length, 0);
  assert.equal(second.sinkFailed, 0);
  assert.equal(second.superseded, 0);
  assert.equal(second.skipped, 0);
  assert.equal((await readMsgOnDisk(root, PANE, "m1")).status, "delivered");
});
