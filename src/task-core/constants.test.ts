// src/task-core/constants.test.ts
// 共享常量单测（票 09）：pin 数值——REPLAY_WINDOW_MS 同时是补发窗（farm filterReplay
// ≤24h 补发）与清理通知守卫严格 > 边界（store deleteTask / cleanup isCleanableTerminal，
// D-A），改动属 cross-cutting 决策，此用例防无意修改后单测静默跟随漂移。
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPLAY_WINDOW_MS } from "./constants.ts";

test("REPLAY_WINDOW_MS = 24h（有限正数）", () => {
  assert.equal(REPLAY_WINDOW_MS, 24 * 3600 * 1000);
  assert.ok(Number.isFinite(REPLAY_WINDOW_MS) && REPLAY_WINDOW_MS > 0);
});
