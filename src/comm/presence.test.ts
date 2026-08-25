// src/comm/presence.test.ts
// presence 写/读原语 + 纯选择器（isAlive/listAlive/resolveRole）用例（票 01 plan §5.2）。
// 只断言外部行为；根目录用 fs.mkdtemp 注入，测试互不串扰。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAlive,
  listAlive,
  readPresences,
  resolveRole,
  writePresence,
  type Presence,
} from "./presence.ts";

const KEYS = ["depth", "heartbeatAt", "paneId", "pid", "role", "taskId"];

async function makeRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "comm-presence-"));
}

function pres(over: Partial<Presence> = {}): Presence {
  return {
    taskId: "task-1",
    paneId: "pane-1",
    role: "planner",
    depth: 1,
    pid: 123,
    heartbeatAt: 1_000_000,
    ...over,
  };
}

test("writePresence 原子：落盘恰 6 字段、0600、无 tmp 残留、返回与磁盘一致", async () => {
  const root = await makeRoot();
  const p = await writePresence(
    root,
    { taskId: "task-1", paneId: "pane-1", role: "planner", depth: 1, pid: 123 },
    5_000,
  );

  assert.equal(p.heartbeatAt, 5_000);
  const file = join(root, "presence", "task-1.json");
  const onDisk = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(onDisk).sort(), KEYS);
  assert.deepEqual(onDisk, p as unknown as Record<string, unknown>);

  const s = await stat(file);
  assert.equal(s.mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, "presence")), ["task-1.json"]);
});

test("writePresence 覆盖：同 taskId 二次写覆盖成功", async () => {
  const root = await makeRoot();
  await writePresence(root, { taskId: "t", paneId: "a", role: "r", depth: 1, pid: 1 }, 1_000);
  await writePresence(root, { taskId: "t", paneId: "b", role: "r2", depth: 2, pid: 2 }, 2_000);

  const all = await readPresences(root);
  assert.equal(all.length, 1);
  assert.equal(all[0].taskId, "t");
  assert.equal(all[0].paneId, "b");
  assert.equal(all[0].depth, 2);
  assert.equal(all[0].heartbeatAt, 2_000);
});

test("readPresences：多文件读、坏 JSON 跳过、非 .json 过滤、taskId 升序", async () => {
  const root = await makeRoot();
  await writePresence(root, { taskId: "task-3", paneId: "p3", role: "r", depth: 1, pid: 1 }, 1);
  await writePresence(root, { taskId: "task-1", paneId: "p1", role: "r", depth: 1, pid: 1 }, 1);
  await writePresence(root, { taskId: "task-2", paneId: "p2", role: "r", depth: 1, pid: 1 }, 1);
  await writeFile(join(root, "presence", "bad.json"), "oops", "utf8");
  await writeFile(join(root, "presence", "note.txt"), "x", "utf8");

  const all = await readPresences(root);
  assert.deepEqual(all.map((p) => p.taskId), ["task-1", "task-2", "task-3"]);
});

test("readPresences：presence 目录不存在 → []", async () => {
  const root = await makeRoot();
  assert.deepEqual(await readPresences(root), []);
});

test("readPresences：taskId 与文件名不符 → 不读（跳过）", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "presence"), { recursive: true });
  // 文件名 wrong.json，但 parsed.taskId = other-task → 身份字段不符
  await writeFile(
    join(root, "presence", "wrong.json"),
    JSON.stringify(pres({ taskId: "other-task" })),
    "utf8",
  );
  // 合法对照
  await writePresence(root, { taskId: "ok", paneId: "p", role: "r", depth: 1, pid: 1 }, 1);

  const all = await readPresences(root);
  assert.deepEqual(all.map((p) => p.taskId), ["ok"]);
});

test("isAlive 边界：距今 10s alive、10s+1 dead、非 number heartbeatAt dead", () => {
  const now = 1_000_000;
  assert.equal(isAlive(pres({ heartbeatAt: now - 10_000 }), now), true);
  assert.equal(isAlive(pres({ heartbeatAt: now }), now), true);
  assert.equal(isAlive(pres({ heartbeatAt: now - 10_001 }), now), false);
  assert.equal(isAlive(pres({ heartbeatAt: Number.NaN }), now), false);
  assert.equal(isAlive(pres({ heartbeatAt: "x" as unknown as number }), now), false);
});

test("resolveRole 多实例：同名 role 全取存活；过期只取存活；role 缺失 → []", () => {
  const now = 1_000_000;
  const a = pres({ taskId: "t1", paneId: "p1", role: "planner", heartbeatAt: now });
  const b = pres({ taskId: "t2", paneId: "p2", role: "planner", heartbeatAt: now });
  const expired = pres({ taskId: "t3", paneId: "p3", role: "planner", heartbeatAt: now - 20_000 });

  assert.deepEqual(resolveRole([a, b, expired], "planner", now), ["p1", "p2"]);
  assert.deepEqual(resolveRole([a, b, expired], "worker", now), []);
});

test("resolveRole 去重保序：同 paneId 多记录只取一次，按 taskId 升序", () => {
  const now = 1_000_000;
  const a = pres({ taskId: "t1", paneId: "p1", role: "r", heartbeatAt: now });
  const b = pres({ taskId: "t2", paneId: "p1", role: "r", heartbeatAt: now });
  const c = pres({ taskId: "t0", paneId: "p2", role: "r", heartbeatAt: now });
  assert.deepEqual(resolveRole([b, a, c], "r", now), ["p2", "p1"]);
});

test("listAlive：过滤过期、taskId 升序", () => {
  const now = 1_000_000;
  const alive2 = pres({ taskId: "t2", heartbeatAt: now });
  const expired = pres({ taskId: "t0", heartbeatAt: now - 99_999 });
  const alive1 = pres({ taskId: "t1", heartbeatAt: now - 1_000 });
  assert.deepEqual(listAlive([alive2, expired, alive1], now).map((p) => p.taskId), ["t1", "t2"]);
});
