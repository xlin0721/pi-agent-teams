// src/task-core/store.test.ts
// 只断言外部行为：返回值 + 磁盘效果（文件内容/权限/残留）；不测内部实现。
// 根目录一律用 fs.mkdtemp 注入（每个用例独立临时目录，结束强制清理）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./store.ts";
import type { TaskRecord } from "./store.ts";

/** 每个用例独立的临时根目录，结束后强制清理。 */
async function withStore(
  fn: (store: TaskStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-store-"));
  const store = new TaskStore(root);
  try {
    await fn(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** §13.3 全字段 task record（顶层字段可覆盖；用于 round-trip 严格比对）。 */
function fullRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t-default",
    type: "spawn",
    parentId: null,
    depth: 0,
    status: "queued",
    owner: "pid+start",
    createdAt: 1_000,
    updatedAt: 1_000,
    startedAt: 0,
    nextAttemptAt: 0,
    notifiedAt: 0,
    timeoutSecs: 300,
    attempts: 0,
    maxAttempts: 2,
    backoffSecs: [5, 30],
    payload: {
      spawn: { form: "tui", role: "tech-director", prompt: "do it", cwd: "/tmp/p1", resumeFrom: null, paneId: "" },
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
    result: {
      sessionDir: "",
      exitCode: null,
      cost: { model: "", inputTokens: 0, outputTokens: 0 },
    },
    ...overrides,
  };
}

// ---------- round-trip ----------

test("readTask/writeTask 原样往返：§13.3 全字段无扩展、mode 0600、无 tmp 残留", async () => {
  await withStore(async (store, root) => {
    const record = fullRecord({
      taskId: "a",
      type: "schedule",
      parentId: "parent-1",
      depth: 1,
      status: "running",
      updatedAt: 2000,
      startedAt: 1500,
      nextAttemptAt: 3000,
      notifiedAt: 4000,
      timeoutSecs: 600,
      attempts: 1,
      payload: {
        spawn: { form: "tui", role: "worker", prompt: "p", cwd: "/w", resumeFrom: "sess-1", paneId: "pane-7" },
        steer: { targetTaskId: "t-other", content: "hi" },
        msg: { targets: ["pane-1", "pane-2"], delivery: "directive", content: "m" },
        schedule: {
          mode: "cron",
          cron: "*/5 * * * *",
          intervalSecs: 0,
          onceAt: 0,
          lastRun: 5,
          nextRun: 300,
          firedTaskIds: ["t-1"],
        },
      },
      result: {
        sessionDir: "/sessions/a",
        exitCode: 0,
        cost: { model: "gpt-x", inputTokens: 12, outputTokens: 34 },
      },
    });
    await store.writeTask(record);
    // 返回值原样往返（strict：多加/漏掉任何字段都失败）
    assert.deepEqual(await store.readTask("a"), record);
    // 磁盘内容就是完整 JSON
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "tasks", "a.json"), "utf8")),
      record,
    );
    // 文件权限 0600
    const s = await stat(join(root, "tasks", "a.json"));
    assert.equal(s.mode & 0o777, 0o600);
    // 写入后 tmp 无残留
    assert.deepEqual(await readdir(join(root, "tasks")), ["a.json"]);
  });
});

test("writeTask 自动创建 tasks 目录（mkdir recursive）", async () => {
  await withStore(async (store, root) => {
    await store.writeTask(fullRecord({ taskId: "a" }));
    const names = await readdir(root);
    assert.ok(names.includes("tasks"));
    assert.equal(await (await readdir(join(root, "tasks"))).length, 1);
  });
});

// ---------- 并发不撕裂 / tmp 清理 ----------

test("并发写同一 taskId：读侧永远见到完整记录（无撕裂）", async () => {
  await withStore(async (store) => {
    const N = 8;
    const variants = Array.from({ length: N }, (_, i) =>
      fullRecord({
        taskId: "race",
        owner: `writer-${i}`,
        updatedAt: i,
        payload: {
          ...fullRecord().payload,
          spawn: { form: "tui", role: "w", prompt: "x".repeat(100_000 + i), cwd: "", resumeFrom: null, paneId: "" },
        },
      }),
    );
    const byUpdatedAt = new Map(variants.map((v) => [v.updatedAt, v]));
    // 先落盘一份初始变体，保证整个竞态窗口内 race.json 始终存在：
    // 此后读侧任何 null 都只能是撕裂（而非"文件尚未创建"）。
    await store.writeTask(variants[0]);
    const writer = (async () => {
      for (let round = 0; round < 10; round++) {
        await Promise.all(variants.map((v) => store.writeTask(v)));
      }
    })();
    const reader = (async () => {
      for (let k = 0; k < 400; k++) {
        const got = await store.readTask("race");
        // 撕裂（半截 JSON）会解析失败为 null
        assert.ok(got !== null, "读侧不应见到 null（撕裂文件）");
        // 每次读到的必须等于某个完整变体
        assert.deepEqual(got, byUpdatedAt.get(got.updatedAt));
      }
    })();
    await Promise.all([writer, reader]);
    // 终态同样是一个完整变体
    const final = await store.readTask("race");
    assert.ok(final !== null);
    assert.deepEqual(final, byUpdatedAt.get(final.updatedAt));
  });
});

test("并发写不同 taskId：互不干扰 + 无 tmp 残留（tmp 名 per-writer 唯一）", async () => {
  await withStore(async (store, root) => {
    const ids = Array.from({ length: 30 }, (_, i) => `task-${String(i).padStart(2, "0")}`);
    await Promise.all(
      ids.map((id, i) => store.writeTask(fullRecord({ taskId: id, owner: `o${i}` }))),
    );
    for (let i = 0; i < ids.length; i++) {
      const r = await store.readTask(ids[i]);
      assert.equal(r?.owner, `o${i}`);
    }
    const names = (await readdir(join(root, "tasks"))).sort();
    assert.deepEqual(names, ids.map((id) => `${id}.json`).sort());
  });
});

test("写入失败（最终路径被目录占据）：抛错 + tmp 被 rm force 清理", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "tasks"), { recursive: true });
    await mkdir(join(root, "tasks", "blocked.json")); // 目录占住最终路径 → rename 失败
    await assert.rejects(store.writeTask(fullRecord({ taskId: "blocked" })));
    // catch 分支清掉了 tmp，目录里只剩占位目录本身
    assert.deepEqual(await readdir(join(root, "tasks")), ["blocked.json"]);
  });
});

// ---------- 扫描快照：可见性与过滤 ----------

test("scanTasks 一次性快照：新增 / 变更 / 删除可见性", async () => {
  await withStore(async (store, root) => {
    assert.deepEqual(await store.scanTasks(), []); // tasks 目录不存在 → 空快照
    await store.writeTask(fullRecord({ taskId: "b" }));
    await store.writeTask(fullRecord({ taskId: "a" }));
    assert.deepEqual((await store.scanTasks()).map((r) => r.taskId), ["a", "b"]);
    // 新增
    await store.writeTask(fullRecord({ taskId: "c" }));
    assert.deepEqual((await store.scanTasks()).map((r) => r.taskId), ["a", "b", "c"]);
    // 变更（重写同 id）
    await store.writeTask(fullRecord({ taskId: "a", status: "done" }));
    const scan = await store.scanTasks();
    assert.equal(scan.find((r) => r.taskId === "a")?.status, "done");
    // 删除（文件移除后下一次扫描不可见）
    await rm(join(root, "tasks", "a.json"));
    assert.deepEqual((await store.scanTasks()).map((r) => r.taskId), ["b", "c"]);
  });
});

test("scanTasks 过滤与容错：非 .json / tmp 名跳过，畸形 json 跳过不抛", async () => {
  await withStore(async (store, root) => {
    await store.writeTask(fullRecord({ taskId: "keep" }));
    const dir = join(root, "tasks");
    await writeFile(join(dir, "notes.txt"), "hello");
    await writeFile(join(dir, ".keep.123.uuuu.tmp"), "half-written");
    await writeFile(join(dir, "broken.json"), "{oops");
    await writeFile(join(dir, "no-ext"), '{"taskId":"x"}');
    assert.deepEqual((await store.scanTasks()).map((r) => r.taskId), ["keep"]);
    // 快照独立性：已返回的数组不随后续写入变化
    const before = await store.scanTasks();
    await store.writeTask(fullRecord({ taskId: "later" }));
    assert.deepEqual(before.map((r) => r.taskId), ["keep"]);
    assert.deepEqual((await store.scanTasks()).map((r) => r.taskId), ["keep", "later"]);
  });
});

// ---------- status 信号 ----------

test("readStatusSignal：无信号 → null（status 目录不存在也不抛）", async () => {
  await withStore(async (store, root) => {
    assert.equal(await store.readStatusSignal("t"), null);
    await mkdir(join(root, "status"), { recursive: true });
    assert.equal(await store.readStatusSignal("t"), null);
  });
});

test("readStatusSignal：.aborted 标记存在 → {kind:'aborted'}", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "status"), { recursive: true });
    await writeFile(join(root, "status", "t.aborted"), "");
    assert.deepEqual(await store.readStatusSignal("t"), { kind: "aborted" });
  });
});

test("readStatusSignal：.done → {kind:'done', exitCode, sessionDir}（含非零退出码）", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "status"), { recursive: true });
    await writeFile(
      join(root, "status", "t.done"),
      JSON.stringify({ exitCode: 0, sessionDir: "/s/t" }),
    );
    assert.deepEqual(await store.readStatusSignal("t"), {
      kind: "done",
      exitCode: 0,
      sessionDir: "/s/t",
    });
    await writeFile(
      join(root, "status", "u.done"),
      JSON.stringify({ exitCode: 7, sessionDir: "/s/u" }),
    );
    assert.deepEqual(await store.readStatusSignal("u"), {
      kind: "done",
      exitCode: 7,
      sessionDir: "/s/u",
    });
  });
});

test("readStatusSignal：.done 与 .aborted 俱在 → done 胜", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "status"), { recursive: true });
    await writeFile(join(root, "status", "t.aborted"), "");
    await writeFile(
      join(root, "status", "t.done"),
      JSON.stringify({ exitCode: 0, sessionDir: "/s/t" }),
    );
    assert.deepEqual(await store.readStatusSignal("t"), {
      kind: "done",
      exitCode: 0,
      sessionDir: "/s/t",
    });
  });
});

test("readStatusSignal 畸形容错：坏 JSON / 缺字段 / 非对象不抛，且不误判 done", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "status"), { recursive: true });
    // 坏 JSON → 不当 done → null
    await writeFile(join(root, "status", "bad.done"), "{not json");
    assert.equal(await store.readStatusSignal("bad"), null);
    // 合法 JSON 但缺字段 → 不当 done → null
    await writeFile(join(root, "status", "miss.done"), JSON.stringify({ sessionDir: "/s/m" }));
    assert.equal(await store.readStatusSignal("miss"), null);
    // exitCode 非 number → 不当 done → null
    await writeFile(
      join(root, "status", "nullcode.done"),
      JSON.stringify({ exitCode: null, sessionDir: "/s/n" }),
    );
    assert.equal(await store.readStatusSignal("nullcode"), null);
    // JSON 根非对象 → 不当 done → null
    await writeFile(join(root, "status", "scalar.done"), JSON.stringify([0, "/s/x"]));
    assert.equal(await store.readStatusSignal("scalar"), null);
    // 坏 .done + .aborted 在 → 回退 aborted（不抛）
    await writeFile(join(root, "status", "bad.aborted"), "");
    assert.deepEqual(await store.readStatusSignal("bad"), { kind: "aborted" });
    // .aborted 是目录（病态）→ null 不抛
    await mkdir(join(root, "status", "dir.aborted"));
    assert.equal(await store.readStatusSignal("dir"), null);
  });
});

// ---------- 陈旧信号过滤（跨票竞态：retry killPane 后旧 wrapper trap 补写的 aborted 残留） ----------

/** 将信号文件 mtime 定格到指定 epoch ms（模拟旧 attempt 时段的残留信号）。 */
async function backdate(path: string, epochMs: number): Promise<void> {
  await utimes(path, new Date(epochMs), new Date(epochMs));
}

test("readStatusSignal：旧 attempt aborted 残留（mtime < 新 startedAt）→ 按无信号（running 仲裁不误判 paneAborted）；新鲜 aborted 仍生效", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "status"), { recursive: true });
    const base = 1_000_000_000_000;
    const startedAt = base + 60_000; // 新 attempt 的 startedAt
    // 旧 attempt 残留：retry killPane 后旧 wrapper trap 补写的 aborted，mtime 定格在旧 attempt 时段
    const stalePath = join(root, "status", "stale.aborted");
    await writeFile(stalePath, "");
    await backdate(stalePath, base);
    assert.equal(await store.readStatusSignal("stale", { since: startedAt }), null);
    // 新鲜 aborted（mtime ≥ since，含等于边界）→ 照常 aborted
    const freshPath = join(root, "status", "fresh.aborted");
    await writeFile(freshPath, "");
    await backdate(freshPath, startedAt);
    assert.deepEqual(await store.readStatusSignal("fresh", { since: startedAt }), { kind: "aborted" });
  });
});

test("readStatusSignal：since 缺省 / 0 / 非有限数 → 不过滤（旧调用方与旧落盘记录兼容）", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "status"), { recursive: true });
    const legacyPath = join(root, "status", "legacy.aborted");
    await writeFile(legacyPath, "");
    await backdate(legacyPath, 1_000_000_000_000);
    // 缺省 / 空 opts / since=0（旧记录 startedAt 归一化）/ NaN → 陈旧信号仍返回
    assert.deepEqual(await store.readStatusSignal("legacy"), { kind: "aborted" });
    assert.deepEqual(await store.readStatusSignal("legacy", {}), { kind: "aborted" });
    assert.deepEqual(await store.readStatusSignal("legacy", { since: 0 }), { kind: "aborted" });
    assert.deepEqual(await store.readStatusSignal("legacy", { since: NaN }), { kind: "aborted" });
  });
});

test("readStatusSignal：同 attempt 迟到 done（mtime > since）→ 仍生效；陈旧 done 过滤；陈旧 done + 新鲜 aborted → aborted", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "status"), { recursive: true });
    const base = 1_000_000_000_000;
    const since = base + 60_000; // 当前 attempt startedAt
    // 迟到 done：本 attempt 启动后写盘（timeout×paneDone 修正边）→ 不受过滤影响
    const latePath = join(root, "status", "late.done");
    await writeFile(latePath, JSON.stringify({ exitCode: 0, sessionDir: "/s/late" }));
    await backdate(latePath, base + 90_000);
    assert.deepEqual(await store.readStatusSignal("late", { since }), {
      kind: "done",
      exitCode: 0,
      sessionDir: "/s/late",
    });
    // 陈旧 done（旧 attempt 残留）→ 过滤为无信号
    const oldDonePath = join(root, "status", "old.done");
    await writeFile(oldDonePath, JSON.stringify({ exitCode: 0, sessionDir: "/s/old" }));
    await backdate(oldDonePath, base);
    assert.equal(await store.readStatusSignal("old", { since }), null);
    // 陈旧 done + 新鲜 aborted → done 胜的优先级对陈旧信号不成立，回退 aborted
    const mixedPath = join(root, "status", "mixed.done");
    await writeFile(mixedPath, JSON.stringify({ exitCode: 0, sessionDir: "/s/mixed" }));
    await backdate(mixedPath, base);
    await writeFile(join(root, "status", "mixed.aborted"), "");
    await backdate(join(root, "status", "mixed.aborted"), since);
    assert.deepEqual(await store.readStatusSignal("mixed", { since }), { kind: "aborted" });
  });
});

// ---------- readTask 畸形容错 ----------

test("readTask：缺文件 → null；坏 JSON → null；JSON 根非对象 → null（均不抛）", async () => {
  await withStore(async (store, root) => {
    assert.equal(await store.readTask("nope"), null);
    await mkdir(join(root, "tasks"), { recursive: true });
    await writeFile(join(root, "tasks", "broken.json"), "{oops");
    assert.equal(await store.readTask("broken"), null);
    await writeFile(join(root, "tasks", "scalar.json"), JSON.stringify("just a string"));
    assert.equal(await store.readTask("scalar"), null);
  });
});

// ---------- taskId 安全段校验 ----------

test("writeTask/readTask：taskId 含路径分隔符或为空 → 抛 TypeError（防路径逃逸）", async () => {
  await withStore(async (store, root) => {
    for (const bad of ["a/b", "a\\b", ""]) {
      await assert.rejects(store.writeTask(fullRecord({ taskId: bad })), TypeError);
      await assert.rejects(store.readTask(bad), TypeError);
    }
    // 校验先于 mkdir/写盘：非法 taskId 不应产生 tasks 目录或任何文件
    const names = await readdir(root);
    assert.ok(!names.includes("tasks"));
  });
});

test("readStatusSignal：taskId 含路径分隔符 → 抛 TypeError（防路径逃逸读信号）", async () => {
  await withStore(async (store) => {
    for (const bad of ["..", "a/b"]) {
      await assert.rejects(store.readStatusSignal(bad), TypeError);
    }
  });
});

// ---------- owner 过滤（单写者三合一） ----------

test("scanTasks owner 过滤：缺省/null = 全量；字符串 = 只返回该 owner 记录", async () => {
  await withStore(async (store) => {
    await store.writeTask(fullRecord({ taskId: "a1", owner: "sess-a" }));
    await store.writeTask(fullRecord({ taskId: "a2", owner: "sess-a" }));
    await store.writeTask(fullRecord({ taskId: "b1", owner: "sess-b" }));
    // 全量：缺省与 null 同义
    assert.deepEqual(
      (await store.scanTasks()).map((r) => r.taskId),
      ["a1", "a2", "b1"],
    );
    assert.deepEqual(
      (await store.scanTasks(null)).map((r) => r.taskId),
      ["a1", "a2", "b1"],
    );
    // 过滤：只返回本 owner；无匹配 → 空快照
    assert.deepEqual(
      (await store.scanTasks("sess-a")).map((r) => r.taskId),
      ["a1", "a2"],
    );
    assert.deepEqual(await store.scanTasks("sess-c"), []);
  });
});

// ---------- 旧落盘记录字段缺失容错 ----------

test("旧记录容错：缺 startedAt/nextAttemptAt/notifiedAt/paneId → 读侧归一化（0/\"\"）；owner 缺失保持缺失", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "tasks"), { recursive: true });
    const base = fullRecord({ taskId: "legacy", owner: "sess-a" });
    const legacy: Record<string, unknown> = { ...base };
    delete legacy.startedAt;
    delete legacy.nextAttemptAt;
    delete legacy.notifiedAt;
    const spawn: Record<string, unknown> = { ...base.payload.spawn };
    delete spawn.paneId;
    delete spawn.form; // 旧记录缺 form → 读侧归一化 "tui"（票 06）
    legacy.payload = { ...base.payload, spawn };
    await writeFile(join(root, "tasks", "legacy.json"), JSON.stringify(legacy));
    const got = await store.readTask("legacy");
    assert.ok(got !== null);
    assert.equal(got.startedAt, 0);
    assert.equal(got.nextAttemptAt, 0);
    assert.equal(got.notifiedAt, 0);
    assert.equal(got.payload.spawn.paneId, "");
    assert.equal(got.payload.spawn.form, "tui"); // form 缺省 tui（票 06）
    // 其余字段原样
    assert.equal(got.status, "queued");
    assert.equal(got.owner, "sess-a");

    // owner 缺失：不补写（存量缺 owner → 只读外务判定依据）
    const noOwner: Record<string, unknown> = { ...base, taskId: "no-owner" };
    delete noOwner.owner;
    await writeFile(join(root, "tasks", "no-owner.json"), JSON.stringify(noOwner));
    const gotNoOwner = await store.readTask("no-owner");
    assert.ok(gotNoOwner !== null);
    assert.equal((gotNoOwner as unknown as Record<string, unknown>).owner, undefined);
  });
});

// ---------- 信号消费（consumeSignal 动作落点） ----------

test("removeStatusSignal：rm 前复查，仅删仍存在的 done/aborted；缺文件/目录不抛", async () => {
  await withStore(async (store, root) => {
    // status 目录不存在：不抛
    await store.removeStatusSignal("t");
    await mkdir(join(root, "status"), { recursive: true });
    // 无文件：不抛
    await store.removeStatusSignal("t");
    // done 存在 → 删除
    await writeFile(
      join(root, "status", "t.done"),
      JSON.stringify({ exitCode: 0, sessionDir: "/s/t" }),
    );
    await store.removeStatusSignal("t");
    await assert.rejects(readFile(join(root, "status", "t.done"), "utf8"));
    // done 与 aborted 俱在 → 全部删除
    await writeFile(
      join(root, "status", "u.done"),
      JSON.stringify({ exitCode: 0, sessionDir: "/s/u" }),
    );
    await writeFile(join(root, "status", "u.aborted"), "");
    await store.removeStatusSignal("u");
    await assert.rejects(readFile(join(root, "status", "u.done"), "utf8"));
    await assert.rejects(readFile(join(root, "status", "u.aborted"), "utf8"));
    // 坏 JSON 的 done 文件同样删除（畸形信号不残留）
    await writeFile(join(root, "status", "bad.done"), "{not json");
    await store.removeStatusSignal("bad");
    await assert.rejects(readFile(join(root, "status", "bad.done"), "utf8"));
    // taskId 安全段校验
    await assert.rejects(store.removeStatusSignal("a/b"), TypeError);
  });
});

test("removeStatusSignal：beforeMs 只删陈旧信号（mtime < cutoff），新信号保留", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "status"), { recursive: true });
    const done = join(root, "status", "t.done");
    await writeFile(done, JSON.stringify({ exitCode: 0, sessionDir: "/s/t" }));
    const aborted = join(root, "status", "t.aborted");
    await writeFile(aborted, "");
    // done 拨旧（本 attempt 之前残留），aborted 保持新鲜（本 attempt 恰写入）
    const old = new Date(Date.now() - 120_000);
    await utimes(done, old, old);
    await store.removeStatusSignal("t", { beforeMs: Date.now() - 60_000 });
    await assert.rejects(readFile(done, "utf8")); // 陈旧 → 删
    await readFile(aborted, "utf8"); // 新鲜 → 保留（留给迟到修正边）
    // beforeMs 缺省 → 旧行为（存在即删，兼容 startedAt=0 存量记录）
    await store.removeStatusSignal("t");
    await assert.rejects(readFile(aborted, "utf8"));
  });
});

// ---------- 复查式删除（票 01 deleteTask） ----------

test("deleteTask：存在且真终态+已通知 → 删除成功；文件消失、scanTasks 不含、无 tmp 残留", async () => {
  await withStore(async (store, root) => {
    await store.writeTask(fullRecord({ taskId: "a", status: "done", notifiedAt: 5_000 }));
    assert.deepEqual(await store.deleteTask("a"), { deleted: true });
    // 文件消失
    await assert.rejects(readFile(join(root, "tasks", "a.json"), "utf8"));
    // 扫描不含；tasks 目录无任何残留（tmp 等）
    assert.deepEqual((await store.scanTasks()).map((r) => r.taskId), []);
    assert.deepEqual(await readdir(join(root, "tasks")), []);
  });
});

test("deleteTask：缺失任务 → no-op 不抛、{deleted:false,reason:'missing'}、无文件产生", async () => {
  await withStore(async (store, root) => {
    assert.deepEqual(await store.deleteTask("nope"), { deleted: false, reason: "missing" });
    // 不产生任何文件/目录（缺文件 → missing，绝不为删除 mkdir）
    assert.deepEqual(await readdir(root), []);
  });
});

test("deleteTask：非法 taskId → 抛 TypeError，且校验先于 I/O（root 无 tasks 目录）", async () => {
  await withStore(async (store, root) => {
    for (const bad of ["", ".", "..", "a/b", "a\\b"]) {
      await assert.rejects(store.deleteTask(bad), TypeError);
    }
    // 校验先于 readTask/rm：非法 id 不应产生 tasks 目录或任何文件
    const names = await readdir(root);
    assert.ok(!names.includes("tasks"));
  });
});

test("deleteTask：幂等删除 + 并发双清（Promise.all）→ 不抛、无残留、结果均为 deleted 或 missing", async () => {
  await withStore(async (store, root) => {
    await store.writeTask(fullRecord({ taskId: "t", status: "done", notifiedAt: 5_000 }));
    // 顺序重删：第一次成功，第二次 missing（readTask=null → no-op）
    assert.deepEqual(await store.deleteTask("t"), { deleted: true });
    await assert.rejects(readFile(join(root, "tasks", "t.json"), "utf8"));
    assert.deepEqual(await store.deleteTask("t"), { deleted: false, reason: "missing" });
    // 并发双清：写回后 Promise.all 两个并发删除。每个结果要么 deleted:true 要么
    // missing（后到者 readTask=null → no-op），绝不抛、绝不 not-terminal/unnotified。
    await store.writeTask(fullRecord({ taskId: "t", status: "done", notifiedAt: 5_000 }));
    const results = await Promise.all([store.deleteTask("t"), store.deleteTask("t")]);
    for (const r of results) {
      assert.ok(
        r.deleted === true || (r.deleted === false && r.reason === "missing"),
        `意外结果: ${JSON.stringify(r)}`,
      );
    }
    assert.ok(results.some((r) => r.deleted === true), "至少一个并发删除成功");
    await assert.rejects(readFile(join(root, "tasks", "t.json"), "utf8"));
    assert.deepEqual(await readdir(join(root, "tasks")), []);
  });
});

test("deleteTask：落盘复查时已非真终态（failed 且 attempts 未用尽→队列可复活）→ not-terminal，文件仍在", async () => {
  await withStore(async (store, root) => {
    await store.writeTask(fullRecord({ taskId: "rev", status: "done", notifiedAt: 5_000 }));
    // 删除前被队列复活：覆写落盘为 retryable failed（attempts < maxAttempts，queue.ts:252）
    await store.writeTask(
      fullRecord({ taskId: "rev", status: "failed", attempts: 1, maxAttempts: 2 }),
    );
    assert.deepEqual(await store.deleteTask("rev"), { deleted: false, reason: "not-terminal" });
    // 文件仍在、记录未被改动（谓词现读，读到的即 rm 前一刻状态）
    assert.equal((await store.readTask("rev"))?.status, "failed");
    await readFile(join(root, "tasks", "rev.json"), "utf8");
  });
});

test("deleteTask：软链任务文件 → 删链接本身、目标文件原样保留（fs.rm 不跟随）", async () => {
  await withStore(async (store, root) => {
    await mkdir(join(root, "tasks"), { recursive: true });
    const target = join(root, "target-outside.json");
    const record = fullRecord({ taskId: "t", status: "done", notifiedAt: 5_000 });
    await writeFile(target, JSON.stringify(record));
    // tasks/t.json 是软链，指向 tasks 目录外的目标文件
    await symlink(target, join(root, "tasks", "t.json"));
    assert.equal((await store.readTask("t"))?.status, "done"); // 读侧跟随软链
    assert.deepEqual(await store.deleteTask("t"), { deleted: true });
    // 链接消失（tasks 目录空），目标文件原样保留
    assert.deepEqual(await readdir(join(root, "tasks")), []);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), record);
  });
});

test("deleteTask：真终态但守卫不过（notifiedAt=0 且 updatedAt 在 24h 补发窗内）→ unnotified，文件仍在", async () => {
  await withStore(async (store, root) => {
    const NOW = 1_700_000_000_000;
    const HOUR = 3600 * 1000;
    // done 但从未通知，1h 前完成（仍在缺省 24h 补发窗内，pin farm.ts:63）
    await store.writeTask(
      fullRecord({ taskId: "quiet", status: "done", notifiedAt: 0, updatedAt: NOW - HOUR }),
    );
    assert.deepEqual(await store.deleteTask("quiet", { now: NOW }), {
      deleted: false,
      reason: "unnotified",
    });
    // 文件仍在、未被改动
    assert.equal((await store.readTask("quiet"))?.status, "done");
    // 显式缩小补发窗（now - updatedAt > replayWindowMs，越过窗外）→ 守卫通过可删
    assert.deepEqual(
      await store.deleteTask("quiet", { now: NOW, replayWindowMs: HOUR / 2 }),
      { deleted: true },
    );
    await assert.rejects(readFile(join(root, "tasks", "quiet.json"), "utf8"));
  });
});
