// src/display/render-mini-pure.test.ts
// 票 04 render-mini 纯函数单测（render-core.test.ts 拆分产物）：buildPiArgs /
// titleSequence / sanitizeTitle / readSpawnFields / killTree。零 SDK import；
// killTree 起真实子进程树验证 pgrep -P 逐层 TERM。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArgs, killTree, readSpawnFields, sanitizeTitle, titleSequence } from "./render-mini.ts";

const TASK_ID = "019ffbb9-f298-7e6d-9b56-a2dd1ce2751d";
const TASK_ID8 = TASK_ID.slice(0, 8);
const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(() => res(), ms));
test("buildPiArgs：定案 A2 拼装（--approve 恒带 / persona 存在才带 / role 空不带）", () => {
  assert.deepEqual(buildPiArgs({ sessionDir: "/tmp/s", role: "", personaFile: "", personaExists: false }), [
    "-p",
    "--mode",
    "rpc",
    "--session-dir",
    "/tmp/s",
    "--approve",
  ]);
  assert.deepEqual(buildPiArgs({ sessionDir: "/s", role: "worker", personaFile: "/p.md", personaExists: true }), [
    "-p",
    "--mode",
    "rpc",
    "--session-dir",
    "/s",
    "--append-system-prompt",
    "/p.md",
    "--name",
    "worker",
    "--approve",
  ]);
  // persona 文件不存在 → 跳过（wrapper 语义同款）
  assert.deepEqual(buildPiArgs({ sessionDir: "/s", role: "r", personaFile: "/gone.md", personaExists: false }), [
    "-p",
    "--mode",
    "rpc",
    "--session-dir",
    "/s",
    "--name",
    "r",
    "--approve",
  ]);
});
test("titleSequence：OSC 0 ⏳ <taskId8> <TITLE>（frontend#9）", () => {
  assert.equal(titleSequence(TASK_ID, "My Title"), `\x1b]0;⏳ ${TASK_ID8} My Title\x07`);
});
test("sanitizeTitle：剥 ANSI/控制符 + 截断 100", () => {
  assert.equal(sanitizeTitle("\x1b[31m红\x07"), "红");
  assert.equal(sanitizeTitle("a\nb\tc"), "abc");
  const clipped = sanitizeTitle("x".repeat(150));
  assert.equal(clipped.length, 100);
  assert.ok(clipped.endsWith("…"));
});
test("titleSequence：title/taskId 注入面 sanitize（无裸 ESC/BEL 逃逸）", () => {
  const out = titleSequence("abc\x1b]0;evil\x07defg", "safe\x07\x1b]0;evil2\x07done");
  assert.equal((out.match(/\x07/g) ?? []).length, 1); // 仅末尾 OSC 收尾 BEL
  assert.equal((out.match(/\x1b/g) ?? []).length, 1); // 仅起始 OSC ESC
  assert.ok(!out.includes("evil"));
  assert.ok(!out.includes("evil2"));
  assert.ok(out.includes("abcdefg safedone"));
});
test("readSpawnFields：payload.spawn.prompt/role + startedAt（坏文件容错零抛）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-mini-"));
  const p = join(dir, "t.json");
  writeFileSync(
    p,
    JSON.stringify({
      taskId: "t",
      startedAt: 12345,
      payload: { spawn: { prompt: "hello\nworld", role: " Worker " } },
    }),
  );
  assert.deepEqual(readSpawnFields(p), { prompt: "hello\nworld", role: "Worker", startedAt: 12345 });
  assert.deepEqual(readSpawnFields(join(dir, "missing.json")), { prompt: "", role: "", startedAt: 0 });
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.deepEqual(readSpawnFields(join(dir, "bad.json")), { prompt: "", role: "", startedAt: 0 });
  rmSync(dir, { recursive: true, force: true });
});
test("killTree：递归树杀真实进程树（backend#3，pgrep -P 逐层 TERM）", async () => {
  // shim 起 sleep 孙子进程后停驻
  const shim = spawn(
    process.execPath,
    ["-e", `const {spawn}=require("node:child_process"); spawn("sleep",["30"]); setInterval(()=>{},1000);`],
    { stdio: "ignore" },
  );
  assert.ok(shim.pid);
  // 等孙子出现
  let grandchild = 0;
  for (let i = 0; i < 40 && grandchild === 0; i++) {
    await delay(50);
    const out = spawnSync("pgrep", ["-P", String(shim.pid)], { encoding: "utf8" });
    const first = (typeof out.stdout === "string" ? out.stdout : "").trim().split(/\s+/)[0];
    if (first !== undefined && first !== "") grandchild = Number(first);
  }
  assert.ok(grandchild > 0, "sleep 孙子进程应已出现");
  killTree(shim.pid!);
  // 两级都应死（zombie 视为已死——等待 reaped）
  const deadOrZombie = (pid: number): boolean => {
    const out = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    const s = (typeof out.stdout === "string" ? out.stdout : "").trim();
    return s === "" || s.includes("Z");
  };
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (!deadOrZombie(shim.pid!) || !deadOrZombie(grandchild))) {
    await delay(50);
  }
  assert.ok(deadOrZombie(shim.pid!), "shim 应已死");
  assert.ok(deadOrZombie(grandchild), "孙子进程应已死");
  // 不存在的 pid 静默
  killTree(999999);
});
