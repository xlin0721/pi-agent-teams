// src/display/split.test.ts
// 只断言外部行为：fake runner 注入验证 argv 契约（--no-auto-start 恒在、无
// --prefer-mux、--cwd 先经 toCliCwd 转换、"--" 分隔 cmd）、spawn stdout 解析为
// pane-id、listPanes 透传 parseList、kill 幂等容忍 spike §6 "no such pane" stderr。
// 真实 cli 调用不单测（spike 结论：并发只读安全、单次 ~1.2s，单测不碰真 mux）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DisplayClient, CliError, toCliCwd } from "./split.ts";
import type { CliOutput, CliRunner, SyncCliOutput, SyncCliRunner } from "./split.ts";
import type { GridPlacement } from "./grid.ts";

/** fake runner：记录每次调用 argv；可编程 stdout/stderr/抛错。 */
class FakeRunner {
  calls: string[][] = [];
  private next: { stdout?: string; stderr?: string; error?: Error } = {};

  onCall(stdout?: string, stderr?: string): void {
    this.next = { stdout, stderr };
  }
  onCallThrow(error: Error): void {
    this.next = { error };
  }

  get fn(): CliRunner {
    return async (args: string[]): Promise<CliOutput> => {
      this.calls.push(args);
      const n = this.next;
      this.next = {};
      if (n.error) throw n.error;
      return { stdout: n.stdout ?? "", stderr: n.stderr ?? "" };
    };
  }
}

function clientWith(fake: FakeRunner): DisplayClient {
  return new DisplayClient(fake.fn);
}

/** 同步 runner fake（killSync 注入接缝）。 */
class FakeSyncRunner {
  calls: string[][] = [];
  private next: { status?: number | null; stderr?: string } = {};

  onCall(status?: number | null, stderr?: string): void {
    this.next = { status, stderr };
  }

  get fn(): SyncCliRunner {
    return (args: string[]): SyncCliOutput => {
      this.calls.push(args);
      const next = this.next;
      this.next = {};
      // status 区分「未设」（默认 0）与显式 null（无法启动 wezterm）
      const status = next.status === undefined ? 0 : next.status;
      return { status, stderr: next.stderr ?? "" };
    };
  }
}

function syncClientWith(fake: FakeSyncRunner): DisplayClient {
  return new DisplayClient(undefined, fake.fn);
}

// ── spawn ──────────────────────────────────────────────────────────────────

test("spawn: argv 契约——cli --no-auto-start split-pane --right -- <cmd>", async () => {
  const fake = new FakeRunner();
  fake.onCall("7\n");
  const paneId = await clientWith(fake).spawn(["pi", "-p", "--mode", "json"]);
  assert.equal(paneId, "7");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0], [
    "cli", "--no-auto-start", "split-pane", "--right", "--", "pi", "-p", "--mode", "json",
  ]);
});

test("spawn: 每次调用都带 --no-auto-start（spike §2/§4 纪律）", async () => {
  const fake = new FakeRunner();
  fake.onCall("1\n");
  await clientWith(fake).spawn(["true"]);
  for (const argv of fake.calls) {
    assert.ok(argv.includes("--no-auto-start"), `缺 --no-auto-start: ${argv.join(" ")}`);
  }
});

test("spawn: 无 cwd 时不传 --cwd（spawn 默认 $HOME 由调用方显式传 cwd 规避，spike §10）", async () => {
  const fake = new FakeRunner();
  fake.onCall("4\n");
  await clientWith(fake).spawn(["bash", "-c", "sleep 5"]);
  assert.deepEqual(fake.calls[0], [
    "cli", "--no-auto-start", "split-pane", "--right", "--", "bash", "-c", "sleep 5",
  ]);
});

test("spawn: --cwd /tmp 前缀转 /private/tmp 形态（spike §1 实测 file:///private/tmp/）", async () => {
  const fake = new FakeRunner();
  fake.onCall("7\n");
  await clientWith(fake).spawn(["true"], { cwd: "/tmp/farm-sess" });
  const argv = fake.calls[0]!;
  assert.deepEqual(argv, [
    "cli", "--no-auto-start", "split-pane", "--right",
    "--cwd", "/private/tmp/farm-sess", "--", "true",
  ]);
});

test("spawn: --cwd 恰为 /tmp → /private/tmp", async () => {
  const fake = new FakeRunner();
  fake.onCall("8\n");
  await clientWith(fake).spawn(["true"], { cwd: "/tmp" });
  assert.equal(fake.calls[0]![5], "/private/tmp");
});

test("spawn: 非 /tmp 路径 cwd 原样传递（--cwd 位于 -- 之前）", async () => {
  const fake = new FakeRunner();
  fake.onCall("9\n");
  await clientWith(fake).spawn(["true"], { cwd: "/Users/x/proj" });
  assert.deepEqual(fake.calls[0], [
    "cli", "--no-auto-start", "split-pane", "--right", "--cwd", "/Users/x/proj", "--", "true",
  ]);
});

test("spawn: 空 cmd 数组也带 -- 分隔符", async () => {
  const fake = new FakeRunner();
  fake.onCall("5\n");
  await clientWith(fake).spawn([]);
  assert.deepEqual(fake.calls[0], ["cli", "--no-auto-start", "split-pane", "--right", "--"]);
});

test("spawn: stdout 前后空白剥除（spike §10：stdout 即 pane-id 打印）", async () => {
  const fake = new FakeRunner();
  fake.onCall("  12 \n");
  assert.equal(await clientWith(fake).spawn(["true"]), "12");
});

test("spawn: stdout 非纯数字 → 抛 CliError（spawn 失败信号，重试归 farm）", async () => {
  const fake = new FakeRunner();
  fake.onCall("no pane: connection lost");
  await assert.rejects(clientWith(fake).spawn(["true"]), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match(err.message, /split-pane 未返回 pane-id/);
    return true;
  });
  fake.onCall("");
  await assert.rejects(clientWith(fake).spawn(["true"]), CliError);
});

// ── spawn placement（票 03） ────────────────────────────────────────────────

test("spawn: placement 替换默认 --right——拼序 --pane-id 42 --right --percent 50，无双 --right", async () => {
  const fake = new FakeRunner();
  fake.onCall("42\n");
  const placement: GridPlacement = { direction: "right", paneId: 42, percent: 50 };
  const paneId = await clientWith(fake).spawn(["true"], { placement });
  assert.equal(paneId, "42");
  assert.deepEqual(fake.calls[0], [
    "cli", "--no-auto-start", "split-pane",
    "--pane-id", "42", "--right", "--percent", "50",
    "--", "true",
  ]);
  // 无双 --right：placement 分支不得残留默认 --right（评审实锤：现状硬编码在 args 数组里）
  assert.equal(fake.calls[0]!.filter((a) => a === "--right").length, 1);
});

test("spawn: placement + --cwd → 先 --cwd（toCliCwd）后 placement args，均位于 -- <cmd> 之前", async () => {
  const fake = new FakeRunner();
  fake.onCall("7\n");
  await clientWith(fake).spawn(["true"], {
    cwd: "/tmp/farm-sess",
    placement: { direction: "bottom", percent: 50 },
  });
  assert.deepEqual(fake.calls[0], [
    "cli", "--no-auto-start", "split-pane",
    "--cwd", "/private/tmp/farm-sess",
    "--bottom", "--percent", "50",
    "--", "true",
  ]);
  assert.ok(!fake.calls[0]!.includes("--right"), "无 paneId 的 bottom placement 也不得出现默认 --right");
});

// ── listPanes ──────────────────────────────────────────────────────────────

test("listPanes: argv 契约 + parseList 透传（真实样本字段回读）", async () => {
  const fake = new FakeRunner();
  fake.onCall(
    JSON.stringify([
      { window_id: 0, tab_id: 0, pane_id: 0, title: "π - pi-agent-teams", cwd: "file:///private/tmp/" },
      { window_id: 0, tab_id: 1, pane_id: 1 },
    ]),
  );
  const panes = await clientWith(fake).listPanes();
  assert.deepEqual(fake.calls[0], ["cli", "--no-auto-start", "list", "--format", "json"]);
  assert.equal(panes.length, 2);
  assert.equal(panes[0]!.pane_id, 0);
  assert.equal(panes[0]!.cwd, "file:///private/tmp/");
  assert.equal(panes[1]!.pane_id, 1);
  assert.equal(panes[1]!.title, undefined);
});

test("listPanes: runner 抛 CliError（L1/exit 1）原样透传，stderr 供 classifyCliFailure", async () => {
  const fake = new FakeRunner();
  fake.onCallThrow(
    new CliError(
      'wezterm cli --no-auto-start list --format json 失败: Command failed',
      '15:14:46.175  ERROR  wezterm > failed to connect to Socket("/tmp/bogus.sock"): connecting to /tmp/bogus.sock; terminating',
    ),
  );
  await assert.rejects(clientWith(fake).listPanes(), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match(err.stderr, /failed to connect to Socket\(/);
    return true;
  });
});

test("listPanes: stdout 非法 JSON → 抛错（other 失败路径，非 L1）", async () => {
  const fake = new FakeRunner();
  fake.onCall("WINID TABID PANEID ..."); // 默认 table 格式漂移
  await assert.rejects(clientWith(fake).listPanes(), /不是合法 JSON/);
});

// ── kill ───────────────────────────────────────────────────────────────────

test("kill: argv 契约——cli --no-auto-start kill-pane --pane-id <id>", async () => {
  const fake = new FakeRunner();
  fake.onCall("");
  await clientWith(fake).kill(42);
  assert.deepEqual(fake.calls[0], ["cli", "--no-auto-start", "kill-pane", "--pane-id", "42"]);
});

test("kill: 字符串 pane-id 原样传递", async () => {
  const fake = new FakeRunner();
  fake.onCall("");
  await clientWith(fake).kill("pane-7");
  assert.equal(fake.calls[0]![4], "pane-7");
});

test("kill: 幂等——stderr 含 no such pane（spike §6）不抛错", async () => {
  const fake = new FakeRunner();
  fake.onCallThrow(
    new CliError(
      "wezterm cli --no-auto-start kill-pane --pane-id 999 失败",
      'ERROR wezterm > unexpected response Ok(ErrorResponse(… "Error: no such pane 999")); terminating',
    ),
  );
  await clientWith(fake).kill(999); // 不抛 = 幂等成立
});

test("kill: 其他 CliError（含 L1）原样抛出", async () => {
  const fake = new FakeRunner();
  fake.onCallThrow(
    new CliError(
      "wezterm cli --no-auto-start kill-pane --pane-id 1 失败",
      '15:14:46.175  ERROR  wezterm > failed to connect to Socket("/tmp/bogus.sock"): connecting to /tmp/bogus.sock; terminating',
    ),
  );
  await assert.rejects(clientWith(fake).kill(1), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match(err.stderr, /failed to connect to Socket\(/);
    return true;
  });
});

// ── killSync（T5 声明接口，06 装配票补齐实现） ─────────────────────────────

test("killSync: argv 契约——cli --no-auto-start kill-pane --pane-id <id>（spawnSync 路径）", () => {
  const fake = new FakeSyncRunner();
  fake.onCall(0);
  syncClientWith(fake).killSync(42);
  assert.deepEqual(fake.calls[0], ["cli", "--no-auto-start", "kill-pane", "--pane-id", "42"]);
});

test("killSync: exit 0 不抛；幂等——stderr 含 no such pane（spike §6）不抛", () => {
  const fake = new FakeSyncRunner();
  fake.onCall(0);
  syncClientWith(fake).killSync(1);
  fake.onCall(1, 'ERROR wezterm > unexpected response Ok(ErrorResponse("no such pane 999")); terminating');
  syncClientWith(fake).killSync(999); // 不抛 = 幂等成立
});

test("killSync: 其他失败（含 L1 stderr、status null 无法启动）→ 抛 CliError（stderr 透传）", () => {
  const fake = new FakeSyncRunner();
  fake.onCall(1, 'ERROR wezterm > failed to connect to Socket("/tmp/bogus.sock"): connecting; terminating');
  assert.throws(() => syncClientWith(fake).killSync(1), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match((err as CliError).message, /kill-pane --pane-id 1 失败/);
    assert.match((err as CliError).stderr, /failed to connect to Socket\(/);
    return true;
  });
  fake.onCall(null, "");
  assert.throws(() => syncClientWith(fake).killSync(2), CliError);
});

// ── toCliCwd ───────────────────────────────────────────────────────────────

test("toCliCwd: darwin /tmp 前缀转换（spike §1），其余原样", () => {
  assert.equal(toCliCwd("/tmp", "darwin"), "/private/tmp");
  assert.equal(toCliCwd("/tmp/a/b", "darwin"), "/private/tmp/a/b");
  assert.equal(toCliCwd("/Users/x", "darwin"), "/Users/x");
  assert.equal(toCliCwd("/tmpx", "darwin"), "/tmpx"); // 前缀边界：/tmpx 不命中
});

test("toCliCwd: 非 darwin 平台不转换", () => {
  assert.equal(toCliCwd("/tmp/a", "linux"), "/tmp/a");
  assert.equal(toCliCwd("/tmp", "win32"), "/tmp");
});

// ── 全局契约 ───────────────────────────────────────────────────────────────

test("禁用 --prefer-mux：任何原语的 argv 都不含（spike §4 硬失败无回退）", async () => {
  const fake = new FakeRunner();
  fake.onCall("3\n");
  await clientWith(fake).spawn(["true"], { cwd: "/tmp/x" });
  fake.onCall(JSON.stringify([]));
  await clientWith(fake).listPanes();
  fake.onCall("");
  await clientWith(fake).kill(3);
  assert.equal(fake.calls.length, 3);
  for (const argv of fake.calls) {
    assert.ok(!argv.includes("--prefer-mux"), `出现 --prefer-mux: ${argv.join(" ")}`);
    assert.ok(argv.includes("--no-auto-start"), `缺 --no-auto-start: ${argv.join(" ")}`);
    assert.equal(argv[0], "cli");
  }
});
