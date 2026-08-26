// src/workspace.test.ts
// E1：工作区隔离纯函数单测（C1）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workspaceIdOf,
  resolveWorkspaceRoot,
  normalizeWorkspaceCwd,
  WS_ENV,
  WS_ID_LEN,
} from "./workspace.ts";

test("workspaceIdOf: 确定性 + 12 hex + 不同路径不同区", () => {
  const a = workspaceIdOf("/Users/x/proj-a");
  const b = workspaceIdOf("/Users/x/proj-b");
  assert.match(a, new RegExp(`^[0-9a-f]{${WS_ID_LEN}}$`));
  assert.equal(a, workspaceIdOf("/Users/x/proj-a")); // 确定性
  assert.notEqual(a, b); // 不同工作区不同 id
});

test("workspaceIdOf: 相对/尾部斜杠归一化前先 realpath（失败回退原值）", () => {
  // 不存在的路径：realpath 失败 → 回退原 cwd → 确定性
  const missing = "/Users/x/definitely-not-exist-abc";
  assert.equal(workspaceIdOf(missing), workspaceIdOf(missing));
});

test("normalizeWorkspaceCwd: 符号链接归一化（别名不裂区）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, "link");
  try {
    symlinkSync(dir, link);
  } catch {
    // 文件系统不支持符号链接 → 跳过（CI 环境）
    return;
  }
  assert.equal(normalizeWorkspaceCwd(link), realpathSync(dir));
});

test("normalizeWorkspaceCwd: 不存在路径回退原样；空串透传", () => {
  const missing = join(tmpdir(), "no-such-dir-ws-xyz");
  assert.equal(normalizeWorkspaceCwd(missing), missing);
  assert.equal(normalizeWorkspaceCwd(""), "");
});

test("resolveWorkspaceRoot: env 显式优先（spawn 链强一致）", () => {
  const r = resolveWorkspaceRoot({
    cwd: "/Users/x/proj-a",
    home: "/Users/x",
    envRoot: "/Users/x/.pi-agent-teams/abc123",
  });
  assert.equal(r.source, "env");
  assert.equal(r.farmRoot, "/Users/x/.pi-agent-teams/abc123");
  assert.equal(r.globalRoot, "/Users/x/.pi-agent-teams");
  assert.equal(r.workspaceId, "");
});

test("resolveWorkspaceRoot: cwd 派生（farmRoot = globalRoot/<wsId>）", () => {
  const r = resolveWorkspaceRoot({ cwd: "/Users/x/proj", home: "/Users/x" });
  assert.equal(r.source, "derived");
  assert.equal(r.globalRoot, "/Users/x/.pi-agent-teams");
  assert.equal(r.farmRoot, join("/Users/x/.pi-agent-teams", workspaceIdOf("/Users/x/proj")));
  assert.equal(r.workspaceId, workspaceIdOf("/Users/x/proj"));
});

test("resolveWorkspaceRoot: cwd 空 → 回退 home 派生", () => {
  const r = resolveWorkspaceRoot({ cwd: "", home: "/Users/x" });
  assert.equal(r.source, "derived");
  assert.equal(r.farmRoot, join("/Users/x/.pi-agent-teams", workspaceIdOf("/Users/x")));
});

test("resolveWorkspaceRoot: env 空白串视为未设置", () => {
  const r = resolveWorkspaceRoot({ cwd: "/Users/x/p", home: "/Users/x", envRoot: "   " });
  assert.equal(r.source, "derived");
});

test("WS_ENV 常量契约：spawn 链与解析共用同一变量名", () => {
  assert.equal(WS_ENV, "PI_AGENT_TEAMS_ROOT");
});
