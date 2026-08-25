// src/task-core/steer.test.ts
// 只断言外部行为：deliver/advance 的返回值与 inbox 目录下的文件效果、
// pickLatest 的输出、非法输入抛错。不测内部实现（不 mock 内部函数）。
// inbox 根目录用 fs.mkdtemp 注入，测试互不串扰。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, pickLatest, type InboxMessage } from "./steer.ts";

const SCHEMA_KEYS = [
  "content",
  "delivery",
  "from",
  "msgId",
  "status",
  "to",
  "ts",
  "type",
];

async function makeInbox(): Promise<{ root: string; inbox: Inbox }> {
  const root = await mkdtemp(join(tmpdir(), "steer-test-"));
  return { root, inbox: new Inbox(root) };
}

function msgPath(root: string, to: string, msgId: string): string {
  return join(root, "inbox", to, `${msgId}.json`);
}

async function readMsg(root: string, to: string, msgId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(msgPath(root, to, msgId), "utf8")) as Record<string, unknown>;
}

function msg(over: Partial<InboxMessage> = {}): InboxMessage {
  return {
    msgId: "00000000-0000-0000-0000-000000000001",
    type: "steer",
    from: "main",
    to: "pane-1",
    delivery: "notice",
    content: "",
    status: "pending",
    ts: 0,
    ...over,
  };
}

// ---------- deliver：schema 严格 + 原子落盘 + 不覆盖 ----------

test("deliver 落盘严格按 §13.3 inbox schema（8 字段、无扩展、无 tmp 残留、0600）", async () => {
  const { root, inbox } = await makeInbox();
  const m = await inbox.deliver({
    type: "steer",
    from: "main",
    to: "pane-1",
    delivery: "directive",
    content: "看这里",
  });

  assert.equal(m.status, "pending");
  assert.equal(m.type, "steer");
  assert.equal(m.from, "main");
  assert.equal(m.to, "pane-1");
  assert.equal(m.delivery, "directive");
  assert.equal(m.content, "看这里");
  assert.equal(typeof m.ts, "number");
  assert.match(m.msgId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // 文件内容与返回值一致，且恰好 8 个 schema 字段（无临时扩展）
  const onDisk = await readMsg(root, "pane-1", m.msgId);
  assert.deepEqual(Object.keys(onDisk).sort(), SCHEMA_KEYS);
  assert.deepEqual(onDisk, m as unknown as Record<string, unknown>);

  // 原子写：目录里只有消息文件本身，无 tmp 残留
  const entries = await readdir(join(root, "inbox", "pane-1"));
  assert.deepEqual(entries, [`${m.msgId}.json`]);

  // 0600 权限
  const s = await stat(msgPath(root, "pane-1", m.msgId));
  assert.equal(s.mode & 0o777, 0o600);
});

test("deliver 两次同 to 不覆盖：msgId 唯一、两条消息都在、内容各自保留", async () => {
  const { root, inbox } = await makeInbox();
  const a = await inbox.deliver({
    type: "steer",
    from: "main",
    to: "pane-1",
    delivery: "notice",
    content: "first",
  });
  const b = await inbox.deliver({
    type: "steer",
    from: "main",
    to: "pane-1",
    delivery: "notice",
    content: "second",
  });

  assert.notEqual(a.msgId, b.msgId);
  assert.equal((await readMsg(root, "pane-1", a.msgId)).content, "first");
  assert.equal((await readMsg(root, "pane-1", b.msgId)).content, "second");
  const entries = (await readdir(join(root, "inbox", "pane-1"))).sort();
  assert.deepEqual(entries, [`${a.msgId}.json`, `${b.msgId}.json`].sort());
});

test("latest-wins 写侧 nonce：同进程 ts 单调递增，后投递者必胜", async () => {
  const { inbox } = await makeInbox();
  const a = await inbox.deliver({ type: "steer", from: "main", to: "p1", delivery: "notice", content: "a" });
  const b = await inbox.deliver({ type: "steer", from: "main", to: "p1", delivery: "notice", content: "b" });
  const c = await inbox.deliver({ type: "steer", from: "main", to: "p1", delivery: "notice", content: "c" });

  assert.ok(a.ts < b.ts && b.ts < c.ts, `期望严格递增，实际 ${a.ts} / ${b.ts} / ${c.ts}`);
  assert.equal(pickLatest([c, a, b])?.content, "c");
});

// ---------- pickLatest ----------

test("pickLatest 乱序输入返回 ts 最大的消息", () => {
  const msgs = [
    msg({ ts: 3, content: "c" }),
    msg({ ts: 1, content: "a" }),
    msg({ ts: 2, content: "b" }),
  ];
  assert.equal(pickLatest(msgs)?.content, "c");
});

test("pickLatest ts 平手取 msgId 字典序大者", () => {
  const lo = msg({ msgId: "00000000-0000-0000-0000-000000000001", ts: 5, content: "lo" });
  const hi = msg({ msgId: "00000000-0000-0000-0000-000000000002", ts: 5, content: "hi" });
  assert.equal(pickLatest([hi, lo])?.content, "hi");
  assert.equal(pickLatest([lo, hi])?.content, "hi");
});

test("pickLatest 空数组返回 null", () => {
  assert.equal(pickLatest([]), null);
});

// ---------- advance：单向推进 ----------

test("advance 严格单步 pending→delivered→read，文件同步更新、其余字段原样", async () => {
  const { root, inbox } = await makeInbox();
  const m = await inbox.deliver({
    type: "steer",
    from: "main",
    to: "pane-1",
    delivery: "directive",
    content: "turn",
  });

  const d = await inbox.advance(m.msgId, "pane-1", "delivered");
  assert.equal(d.status, "delivered");
  assert.equal((await readMsg(root, "pane-1", m.msgId)).status, "delivered");

  const r = await inbox.advance(m.msgId, "pane-1", "read");
  assert.equal(r.status, "read");
  const onDisk = await readMsg(root, "pane-1", m.msgId);
  assert.equal(onDisk.status, "read");
  // 推进只改 status：其余字段（含 ts nonce）原样保留
  assert.deepEqual({ ...onDisk, status: "pending" }, m as unknown as Record<string, unknown>);
  // schema 不被推进污染
  assert.deepEqual(Object.keys(onDisk).sort(), SCHEMA_KEYS);
});

test("advance 非法回退/重复/跳级抛错（单向推进不可逆）", async () => {
  const { inbox } = await makeInbox();
  const m = await inbox.deliver({ type: "steer", from: "main", to: "p1", delivery: "notice", content: "" });

  // 跳级：pending→read
  await assert.rejects(inbox.advance(m.msgId, "p1", "read"), /pending -> read/);

  await inbox.advance(m.msgId, "p1", "delivered");
  // 重复：delivered→delivered
  await assert.rejects(inbox.advance(m.msgId, "p1", "delivered"), /delivered -> delivered/);

  await inbox.advance(m.msgId, "p1", "read");
  // 回退：read→delivered
  await assert.rejects(inbox.advance(m.msgId, "p1", "delivered"), /read -> delivered/);
  // 重复：read→read
  await assert.rejects(inbox.advance(m.msgId, "p1", "read"), /read -> read/);
});

test("advance 消息不存在抛错", async () => {
  const { inbox } = await makeInbox();
  await assert.rejects(
    inbox.advance("123e4567-e89b-12d3-a456-426614174000", "p1", "delivered"),
    /not found/,
  );
});

test("advance 读到坏 JSON 消息文件：抛带 msgId 上下文的 Error，保留具体解析原因", async () => {
  const { root, inbox } = await makeInbox();
  const msgId = "123e4567-e89b-12d3-a456-426614174000";
  await mkdir(join(root, "inbox", "p1"), { recursive: true });
  await writeFile(msgPath(root, "p1", msgId), "oops-bad-json", "utf8");

  await assert.rejects(inbox.advance(msgId, "p1", "delivered"), (err: unknown) => {
    assert.ok(err instanceof Error, "抛的是 Error");
    assert.ok(!(err instanceof SyntaxError), "不抛裸 SyntaxError");
    assert.ok(err.message.includes(msgId), `message 含 msgId：${err.message}`);
    assert.match(err.message, /Unexpected token/, `保留 JSON.parse 原因：${err.message}`);
    return true;
  });
});

test("advance 读到 JSON 合法但根非对象（null/数组）：抛带 msgId 上下文的 Error，不再是裸 TypeError", async () => {
  const { root, inbox } = await makeInbox();
  const msgId = "123e4567-e89b-12d3-a456-426614174000";
  await mkdir(join(root, "inbox", "p1"), { recursive: true });
  for (const raw of ["null", "[]"]) {
    await writeFile(msgPath(root, "p1", msgId), raw, "utf8");
    await assert.rejects(inbox.advance(msgId, "p1", "delivered"), (err: unknown) => {
      assert.ok(err instanceof Error, "抛的是 Error");
      assert.ok(!(err instanceof TypeError), `不是裸 TypeError：${String(err)}`);
      assert.match(err.message, /invalid message JSON/);
      assert.ok(err.message.includes(msgId), `message 含 msgId：${err.message}`);
      return true;
    });
  }
});

// ---------- 路径逃逸 ----------

test("路径逃逸防御：to/msgId 含目录成分或 .. 一律抛错，且无文件逃逸", async () => {
  const { root, inbox } = await makeInbox();

  await assert.rejects(
    inbox.deliver({ type: "steer", from: "main", to: "../evil", delivery: "notice", content: "" }),
    TypeError,
  );
  await assert.rejects(
    inbox.deliver({ type: "steer", from: "main", to: "a/b", delivery: "notice", content: "" }),
    TypeError,
  );
  await assert.rejects(
    inbox.deliver({ type: "steer", from: "main", to: "a\\b", delivery: "notice", content: "" }),
    TypeError,
  );
  await assert.rejects(
    inbox.deliver({ type: "steer", from: "main", to: "..", delivery: "notice", content: "" }),
    TypeError,
  );
  await assert.rejects(
    inbox.deliver({ type: "steer", from: "main", to: "", delivery: "notice", content: "" }),
    TypeError,
  );

  await assert.rejects(inbox.advance("../../secret", "p1", "delivered"), TypeError);
  await assert.rejects(inbox.advance("m1", "../p1", "delivered"), TypeError);
  await assert.rejects(inbox.advance("m1", "p1/..", "delivered"), TypeError);
  await assert.rejects(inbox.advance("", "p1", "delivered"), TypeError);
  await assert.rejects(inbox.advance("m1", "", "delivered"), TypeError);

  // 逃逸未发生：注入根目录下没有任何文件/目录被创建
  assert.deepEqual(await readdir(root), []);
});

// ---------- 非法枚举 ----------

test("deliver 非法枚举抛错：type 仅 steer|msg，delivery 仅 notice|directive", async () => {
  const { inbox } = await makeInbox();
  await assert.rejects(
    // @ts-expect-error 运行时防御：JS 调用方可能传非法枚举（schema 外）
    inbox.deliver({ type: "poke", from: "main", to: "p1", delivery: "notice", content: "" }),
    TypeError,
  );
  await assert.rejects(
    // @ts-expect-error 运行时防御：JS 调用方可能传非法枚举（schema 外）
    inbox.deliver({ type: "steer", from: "main", to: "p1", delivery: "yell", content: "" }),
    TypeError,
  );
});

test("advance 非法 next 抛错：仅 delivered|read（pending 也不可作 next）", async () => {
  const { inbox } = await makeInbox();
  const m = await inbox.deliver({ type: "steer", from: "main", to: "p1", delivery: "notice", content: "" });
  // @ts-expect-error 运行时防御：pending 不可作 next（严格单步推进）
  await assert.rejects(inbox.advance(m.msgId, "p1", "pending"), TypeError);
  // @ts-expect-error 运行时防御：JS 调用方可能传非法值（schema 外）
  await assert.rejects(inbox.advance(m.msgId, "p1", "bogus"), TypeError);
  // @ts-expect-error 运行时防御：JS 调用方可能传 undefined
  await assert.rejects(inbox.advance(m.msgId, "p1", undefined), TypeError);
});

test("deliver 缺字段/空 from/非法 content 抛错", async () => {
  const { inbox } = await makeInbox();
  // @ts-expect-error content 缺失
  await assert.rejects(inbox.deliver({ type: "steer", from: "main", to: "p1", delivery: "notice" }), TypeError);
  // @ts-expect-error type 缺失
  await assert.rejects(inbox.deliver({ from: "main", to: "p1", delivery: "notice", content: "" }), TypeError);
  await assert.rejects(
    inbox.deliver({ type: "steer", from: "", to: "p1", delivery: "notice", content: "" }),
    TypeError,
  );
  await assert.rejects(
    // @ts-expect-error content 非字符串（运行时防御：JS 调用方可能传错类型）
    inbox.deliver({ type: "steer", from: "main", to: "p1", delivery: "notice", content: 42 }),
    TypeError,
  );
});

test("Inbox 构造防御：空根目录抛 TypeError", () => {
  assert.throws(() => new Inbox(""), TypeError);
});
