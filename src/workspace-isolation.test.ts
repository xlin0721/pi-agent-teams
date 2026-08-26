// src/workspace-isolation.test.ts
// E3（C1 合入门槛）：跨区隔离——两个临时 root（A/B 工作区）经公开 API 互不可见。
// 验证 C1 分区语义：TaskStore / Inbox / presence 均以注入 root 为界，A 区永远
// 看不到 B 区的任务/消息/存活实例（结构性隔离，非过滤纪律）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./task-core/store.ts";
import type { TaskRecord } from "./task-core/store.ts";
import { Inbox } from "./task-core/steer.ts";
import { readInboxSnapshot } from "./comm/inbox.ts";
import { writePresence, readPresences } from "./comm/presence.ts";
import { workspaceIdOf } from "./workspace.ts";

function makeTask(taskId: string, cwd: string, paneId: string): TaskRecord {
  return {
    taskId,
    type: "spawn",
    parentId: null,
    depth: 1,
    status: "done",
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
      spawn: { role: "worker", prompt: "p", cwd, resumeFrom: null, form: "worker", paneId },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: [], delivery: "notice", content: "" },
      schedule: { mode: "once", cron: "", intervalSecs: 0, onceAt: 0, lastRun: 0, nextRun: 0, firedTaskIds: [] },
    },
    result: { sessionDir: "", exitCode: 0, cost: { model: "m", inputTokens: 0, outputTokens: 0 } },
  };
}

function makeRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ws-iso-${label}-`));
  return dir;
}

test("E3: TaskStore 分区——A 区 scanTasks 不见 B 区任务（不同 workspaceId 不同 root）", async () => {
  const rootA = makeRoot("a");
  const rootB = makeRoot("b");
  try {
    const storeA = new TaskStore(rootA);
    const storeB = new TaskStore(rootB);
    await storeA.writeTask(makeTask("task-a", "/proj/a", "pane-a"));
    await storeB.writeTask(makeTask("task-b", "/proj/b", "pane-b"));

    const idsA = (await storeA.scanTasks(null)).map((t) => t.taskId);
    const idsB = (await storeB.scanTasks(null)).map((t) => t.taskId);
    assert.deepEqual(idsA, ["task-a"]);
    assert.deepEqual(idsB, ["task-b"]);
    // 结构性隔离：A 的存储里根本没有 B 的文件
    assert.equal(await storeA.readTask("task-b"), null);
    assert.equal(await storeB.readTask("task-a"), null);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("E3: Inbox 分区——A 区投递的消息不在 B 区可见", async () => {
  const rootA = makeRoot("a");
  const rootB = makeRoot("b");
  try {
    const inboxA = new Inbox(rootA);
    await inboxA.deliver({ type: "msg", from: "main", to: "pane-a", delivery: "directive", content: "hi-a" });

    const snapA = await readInboxSnapshot(rootA, "pane-a");
    const snapB = await readInboxSnapshot(rootB, "pane-a"); // 同名 paneId 在 B 区不存在
    assert.equal(snapA.length, 1);
    assert.equal(snapA[0].content, "hi-a");
    assert.equal(snapB.length, 0);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("E3: presence 分区——A 区 readPresences 不含 B 区实例", async () => {
  const rootA = makeRoot("a");
  const rootB = makeRoot("b");
  try {
    await writePresence(rootA, { taskId: "task-a", paneId: "pane-a", role: "worker", depth: 1, pid: 1 });
    await writePresence(rootB, { taskId: "task-b", paneId: "pane-b", role: "worker", depth: 1, pid: 2 });

    const presA = await readPresences(rootA);
    const presB = await readPresences(rootB);
    assert.deepEqual(presA.map((p) => p.taskId), ["task-a"]);
    assert.deepEqual(presB.map((p) => p.taskId), ["task-b"]);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("E3: 不同 cwd 派生不同 workspaceId（隔离键语义）", () => {
  const idA = workspaceIdOf("/Users/x/proj-a");
  const idB = workspaceIdOf("/Users/x/proj-b");
  assert.notEqual(idA, idB);
  assert.match(idA, /^[0-9a-f]{12}$/);
});
