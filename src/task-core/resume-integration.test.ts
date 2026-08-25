// src/task-core/resume-integration.test.ts
// resume 迁移边集成（M3 收口票 10 增补）：真 TaskStore + executeResume（真
// findSessionId 从会话 jsonl 文件名解析 session id）→ aborted × resume → queued
// + payload.spawn.resumeFrom 落盘（owner 不变、updatedAt 刷新、attempts 不重置）。
// 只断言外部行为（盘上 task record / ack 文案）。零依赖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./store.ts";
import type { TaskRecord } from "./store.ts";
import { executeResume } from "../steer-tool.ts";
import { findSessionId } from "./resume.ts";

const OWNER = "99999+1700000000000";

/** §13.3 全字段 task record fixture（测试按需覆写） */
function fullRecord(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  const t0 = 1_000_000;
  return {
    type: "spawn",
    parentId: null,
    depth: 1,
    status: overrides.status ?? "aborted",
    owner: overrides.owner ?? OWNER,
    createdAt: overrides.createdAt ?? t0,
    updatedAt: overrides.updatedAt ?? t0,
    startedAt: overrides.startedAt ?? t0,
    nextAttemptAt: overrides.nextAttemptAt ?? 0,
    notifiedAt: overrides.notifiedAt ?? 0,
    timeoutSecs: overrides.timeoutSecs ?? 600,
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 2,
    backoffSecs: overrides.backoffSecs ?? [5, 30],
    payload: {
      spawn: { form: "tui", role: "explorer", prompt: "probe the thing", cwd: "", resumeFrom: null, paneId: "pane-9" },
      steer: { targetTaskId: "", content: "" },
      msg: { targets: [], delivery: "notice", content: "" },
      schedule: { mode: "once", cron: "", intervalSecs: 0, onceAt: 0, lastRun: 0, nextRun: 0, firedTaskIds: [] },
    },
    result: { sessionDir: "", exitCode: null, cost: { model: "", inputTokens: 0, outputTokens: 0 } },
    ...overrides,
  };
}

test("resume 迁移边：aborted × resume → queued + payload.spawn.resumeFrom 落盘（真 store + 真 findSessionId）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(root);

  const taskId = "t-aborted";
  const sessionId = "0e2f0e2f-1111-2222-3333-444455556666";
  const sessionDir = join(root, "sessions", taskId);
  await mkdir(sessionDir, { recursive: true });
  // 真 findSessionId 数据源：sessions/<taskId>/<ts>_<uuid>.jsonl
  await writeFile(join(sessionDir, `200000_${sessionId}.jsonl`), "{}\n", "utf8");

  await store.writeTask(
    fullRecord({
      taskId,
      status: "aborted",
      result: { sessionDir, exitCode: null, cost: { model: "", inputTokens: 0, outputTokens: 0 } },
    }),
  );

  const res = await executeResume(
    { taskId },
    {
      readTask: (id) => store.readTask(id),
      scanTasks: (owner) => store.scanTasks(owner),
      writeTask: (r) => store.writeTask(r),
      findSessionId: (dir) => findSessionId(dir),
      owner: OWNER,
      now: () => 1_000_500,
    },
  );

  // ack 文案（resumeAckText 口径）
  assert.match(res.content[0]!.text, /已恢复任务/);
  assert.match(res.content[0]!.text, /排队位置 1/);

  // 迁移边落盘：aborted → queued + resumeFrom = 解析的 session id
  const onDisk = await store.readTask(taskId);
  assert.equal(onDisk?.status, "queued", "aborted × resume → queued");
  assert.equal(onDisk?.payload.spawn.resumeFrom, sessionId, "resumeFrom 落盘 = 解析的 session id");
  assert.equal(onDisk?.updatedAt, 1_000_500, "updatedAt 刷新为 now");
  assert.equal(onDisk?.owner, OWNER, "owner 不变");
  assert.equal(onDisk?.attempts, 0, "attempts 不重置（沿用原值）");
});
