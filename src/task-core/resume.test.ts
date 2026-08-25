// src/task-core/resume.test.ts
// 只断言外部行为：输入 → 输出（参数数组 / 解析结果 / 抛错），不测内部实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResumeArgs, findSessionId, parseSessionId } from "./resume.ts";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

// ---------- buildResumeArgs ----------

test("buildResumeArgs 形态逐段：-p / --session-dir <dir> / --session <id> 齐全且顺序正确", () => {
  const dir = "/tmp/pi-sessions/task-1";
  const args = buildResumeArgs(dir, UUID);
  assert.equal(args.length, 5);
  assert.equal(args[0], "-p");
  assert.equal(args[1], "--session-dir");
  assert.equal(args[2], dir);
  assert.equal(args[3], "--session");
  assert.equal(args[4], UUID);
});

test("buildResumeArgs 返回 args-only：不含 \"pi\"", () => {
  const args = buildResumeArgs("d", UUID);
  assert.equal(args.includes("pi"), false);
  assert.deepEqual(args, ["-p", "--session-dir", "d", "--session", UUID]);
});

test("buildResumeArgs 空格与中文透传（原样保留）", () => {
  const dir = "/tmp/my sessions/任务 一";
  const id = "会话-abc";
  assert.deepEqual(buildResumeArgs(dir, id), [
    "-p",
    "--session-dir",
    dir,
    "--session",
    id,
  ]);
});

test("buildResumeArgs 空串防御：任一入参空串抛 TypeError", () => {
  assert.throws(() => buildResumeArgs("", UUID), TypeError);
  assert.throws(() => buildResumeArgs("/tmp/x", ""), TypeError);
  assert.throws(() => buildResumeArgs("", ""), TypeError);
});

// ---------- parseSessionId ----------

test("parseSessionId 标准形 `*_<uuid>.jsonl` 提取 uuid", () => {
  assert.equal(parseSessionId(`session_${UUID}.jsonl`), UUID);
  assert.equal(parseSessionId(`agent_main_${UUID}.jsonl`), UUID);
  assert.equal(parseSessionId(`_${UUID}.jsonl`), UUID);
  assert.equal(parseSessionId(`t1_${UUID}.jsonl`), UUID);
});

test("parseSessionId 无 uuid → null", () => {
  assert.equal(parseSessionId("session.jsonl"), null);
  assert.equal(parseSessionId("_.jsonl"), null);
  assert.equal(parseSessionId("abc.jsonl"), null);
});

test("parseSessionId 非 jsonl 结尾 → null", () => {
  assert.equal(parseSessionId(`session_${UUID}.txt`), null);
  assert.equal(parseSessionId(`session_${UUID}.jsonl.bak`), null);
  assert.equal(parseSessionId(UUID), null);
  assert.equal(parseSessionId(`session_${UUID}`), null);
});

test("parseSessionId 多 uuid → null", () => {
  assert.equal(parseSessionId(`${UUID}_${UUID}.jsonl`), null);
  assert.equal(parseSessionId(`a_${UUID}_b_${UUID}.jsonl`), null);
});

test("parseSessionId uuid 不在尾段 → null", () => {
  assert.equal(parseSessionId(`a_${UUID}_extra.jsonl`), null);
  assert.equal(parseSessionId(`${UUID}.jsonl`), null); // 无 `_<uuid>` 前缀
  assert.equal(parseSessionId(`a_${UUID}x.jsonl`), null); // uuid 后粘非 jsonl 字符
});

test("parseSessionId 空串 / 非字符串 → null", () => {
  assert.equal(parseSessionId(""), null);
  // @ts-expect-error 防御性运行时行为（JS 调用方可能传入非字符串）
  assert.equal(parseSessionId(undefined), null);
  // @ts-expect-error 同上
  assert.equal(parseSessionId(123), null);
});

test("parseSessionId 大写 uuid 原样返回（不 lowercase）", () => {
  const upper = "123E4567-E89B-12D3-A456-426614174000";
  assert.equal(parseSessionId(`s_${upper}.jsonl`), upper);
});

test("解析结果可直接喂回 buildResumeArgs（roundtrip）", () => {
  const dir = "/tmp/sessions/x";
  const id = parseSessionId(`session_${UUID}.jsonl`);
  assert.ok(id !== null, "fixture uuid 必须可解析");
  assert.deepEqual(buildResumeArgs(dir, id), [
    "-p",
    "--session-dir",
    dir,
    "--session",
    UUID,
  ]);
});

// ---------- findSessionId ----------

test("findSessionId：目录不存在 / 空串 / 无合法 jsonl → null（不抛）", async () => {
  assert.equal(await findSessionId(""), null);
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-resume-"));
  assert.equal(await findSessionId(join(root, "missing")), null);
  await writeFile(join(root, "note.txt"), "x");
  await writeFile(join(root, "no-uuid.jsonl"), "x");
  assert.equal(await findSessionId(root), null);
});

test("findSessionId：取倒序第一个可解析 jsonl 的 session id（= 最新落盘）", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-teams-resume-"));
  const id1 = "123e4567-e89b-12d3-a456-426614174000";
  const id2 = "123e4567-e89b-12d3-a456-426614174999";
  await writeFile(join(root, `100_${id1}.jsonl`), "x");
  await writeFile(join(root, `200_${id2}.jsonl`), "x");
  // 倒序文件名 200 > 100：返回 id2
  assert.equal(await findSessionId(root), id2);
  // 非 jsonl / 坏文件名夹在中间不阻断
  await writeFile(join(root, `300_badname.jsonl`), "x");
  assert.equal(await findSessionId(root), id2);
});
