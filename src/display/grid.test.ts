// src/display/grid.test.ts
// 只断言外部行为：parseWeztermPaneId / selectSplitTarget / computeGridPlacement /
// placementToArgs / computePlacementFromSnapshot 的纯函数落点决策。
// 零 I/O：不碰真实 wezterm cli；逻辑层禁源码文本断言（经公开 API 行为断言）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWeztermPaneId,
  selectSplitTarget,
  computeGridPlacement,
  placementToArgs,
  computePlacementFromSnapshot,
} from "./grid.ts";
import type { PaneInfo } from "./protocol.ts";
import type { GridPlacement } from "./grid.ts";

/** 测试 pane 构造器：省略字段全 undefined。 */
function pane(
  id: number,
  opts: { window?: number; tab?: number; rows?: number; cols?: number } = {},
): PaneInfo {
  const { window = 0, tab = 0, rows, cols } = opts;
  const info: PaneInfo = { window_id: window, tab_id: tab, pane_id: id };
  if (rows !== undefined && cols !== undefined) {
    info.size = { rows, cols };
  }
  return info;
}

test("parseWeztermPaneId: 纯数字串 → number", () => {
  assert.equal(parseWeztermPaneId("42"), 42);
  assert.equal(parseWeztermPaneId("0"), 0);
});

test("parseWeztermPaneId: 空串 → null", () => {
  assert.equal(parseWeztermPaneId(""), null);
});

test("parseWeztermPaneId: 非数字 → null", () => {
  assert.equal(parseWeztermPaneId("abc"), null);
  assert.equal(parseWeztermPaneId("12a"), null);
  assert.equal(parseWeztermPaneId("-1"), null);
  assert.equal(parseWeztermPaneId(" 42"), null);
});

test("parseWeztermPaneId: undefined → null", () => {
  assert.equal(parseWeztermPaneId(undefined), null);
});

test("selectSplitTarget: 窗口过滤——异窗口大 pane 不参与", () => {
  const panes = [
    pane(1), // own，window 0/tab 0，面积 80
    pane(2, { window: 1 }), // 异窗口，面积超大
    pane(3, { rows: 8, cols: 10 }), // 同窗口，面积 80
  ];
  assert.deepEqual(selectSplitTarget(panes, 1), { paneId: 3, direction: "right" });
});

test("selectSplitTarget: tab 过滤——异 tab 大 pane 不参与", () => {
  const panes = [
    pane(1),
    pane(2, { tab: 1, rows: 100, cols: 100 }),
    pane(3, { rows: 8, cols: 10 }),
  ];
  assert.deepEqual(selectSplitTarget(panes, 1), { paneId: 3, direction: "right" });
});

test("selectSplitTarget: 排除 own——own 面积最大也不选中", () => {
  const panes = [
    pane(1, { rows: 100, cols: 100 }), // own 面积最大
    pane(2, { rows: 8, cols: 10 }), // 面积 80
    pane(3, { rows: 4, cols: 5 }), // 面积 20
  ];
  assert.deepEqual(selectSplitTarget(panes, 1), { paneId: 2, direction: "right" });
});

test("selectSplitTarget: 取面积最大者", () => {
  const panes = [
    pane(1, { rows: 4, cols: 5 }), // own 面积 20
    pane(2, { rows: 2, cols: 3 }), // 面积 6
    pane(3, { rows: 9, cols: 10 }), // 面积 90 最大，cols>rows → right
    pane(4, { rows: 5, cols: 5 }), // 面积 25
  ];
  assert.deepEqual(selectSplitTarget(panes, 1), { paneId: 3, direction: "right" });
});

test("selectSplitTarget: 面积缺失跳过（size 缺失 / rows 缺失 / cols 缺失）", () => {
  const noSize = pane(2);
  const noRows = pane(3, { cols: 20 });
  const noCols = pane(4, { rows: 20 });
  const full = pane(5, { rows: 6, cols: 7 }); // 面积 42
  // size 缺失的 pane 排最前（若误当作 0 面积会被跳过）；full 应被选中。
  assert.deepEqual(selectSplitTarget([pane(1), noSize, noRows, noCols, full], 1), {
    paneId: 5,
    direction: "right",
  });
});

test("selectSplitTarget: 排除 own 后空集 → null", () => {
  assert.equal(selectSplitTarget([pane(1, { rows: 5, cols: 5 })], 1), null);
});

test("selectSplitTarget: 其余 pane 面积全缺失 → null", () => {
  const panes = [pane(1, { rows: 5, cols: 5 }), pane(2), pane(3, { rows: 9 })];
  assert.equal(selectSplitTarget(panes, 1), null);
});

test("selectSplitTarget: 方向 cols>rows → right；rows>=cols → bottom", () => {
  // 宽 pane（cols>rows）→ right
  assert.deepEqual(
    selectSplitTarget([pane(1), pane(2, { rows: 4, cols: 9 })], 1),
    { paneId: 2, direction: "right" },
  );
  // 高 pane（rows>cols）→ bottom
  assert.deepEqual(
    selectSplitTarget([pane(1), pane(2, { rows: 9, cols: 4 })], 1),
    { paneId: 2, direction: "bottom" },
  );
  // 正方形（rows==cols）→ bottom（cols>rows 不成立）
  assert.deepEqual(
    selectSplitTarget([pane(1), pane(2, { rows: 5, cols: 5 })], 1),
    { paneId: 2, direction: "bottom" },
  );
});

test("computeGridPlacement: ownPaneId 不在列表 → null", () => {
  assert.equal(computeGridPlacement([pane(1), pane(2, { rows: 5, cols: 5 })], 99), null);
});

test("computeGridPlacement: 同 tab ≤1 pane → 首分裂 right/50", () => {
  assert.deepEqual(computeGridPlacement([pane(1, { rows: 5, cols: 5 })], 1), {
    direction: "right",
    percent: 50,
  });
});

test("computeGridPlacement: 异 tab 的 pane 不计入窗口内数 → 仍首分裂", () => {
  const panes = [pane(1), pane(2, { tab: 1, rows: 100, cols: 100 })];
  assert.deepEqual(computeGridPlacement(panes, 1), { direction: "right", percent: 50 });
});

test("computeGridPlacement: 多 pane → 平衡落点（paneId + 最大 pane + percent 50）", () => {
  const panes = [
    pane(1, { rows: 4, cols: 5 }),
    pane(2, { rows: 2, cols: 3 }),
    pane(3, { rows: 9, cols: 10 }), // 面积最大 90，cols>rows → right
  ];
  assert.deepEqual(computeGridPlacement(panes, 1), {
    direction: "right",
    paneId: 3,
    percent: 50,
  });
});

test("computeGridPlacement: 多 pane 但其余全无面积 → null（回退 --right）", () => {
  const panes = [pane(1, { rows: 5, cols: 5 }), pane(2), pane(3, { rows: 9 })];
  assert.equal(computeGridPlacement(panes, 1), null);
});

test("placementToArgs: direction 四向映射 right/bottom/left/top", () => {
  assert.deepEqual(placementToArgs({ direction: "right" }), ["--right", "--percent", "50"]);
  assert.deepEqual(placementToArgs({ direction: "bottom" }), ["--bottom", "--percent", "50"]);
  assert.deepEqual(placementToArgs({ direction: "left" }), ["--left", "--percent", "50"]);
  assert.deepEqual(placementToArgs({ direction: "top" }), ["--top", "--percent", "50"]);
});

test("placementToArgs: paneId 前置 --pane-id", () => {
  assert.deepEqual(placementToArgs({ direction: "right", paneId: 7, percent: 50 }), [
    "--pane-id",
    "7",
    "--right",
    "--percent",
    "50",
  ]);
});

test("placementToArgs: topLevel 拼 --top-level", () => {
  assert.deepEqual(placementToArgs({ direction: "right", percent: 50, topLevel: true }), [
    "--right",
    "--percent",
    "50",
    "--top-level",
  ]);
});

test("placementToArgs: percent 透传与缺省 50", () => {
  assert.deepEqual(placementToArgs({ direction: "bottom", percent: 33 }), [
    "--bottom",
    "--percent",
    "33",
  ]);
  assert.deepEqual(placementToArgs({ direction: "bottom" }), ["--bottom", "--percent", "50"]);
  assert.deepEqual(placementToArgs({ direction: "bottom", percent: 0 }), [
    "--bottom",
    "--percent",
    "0",
  ]);
});

test("placementToArgs: 不产出 --help 字面量（3e）", () => {
  // 拆词构造禁用 flag，避免本测试自身触发 3e 引号字面量 grep 门。
  const HELP_FLAG = ["--", "help"].join("");
  const cases: GridPlacement[] = [
    { direction: "right" },
    { direction: "bottom", percent: 33 },
    { direction: "left", paneId: 1 },
    { direction: "top", topLevel: true },
    { direction: "right", paneId: 2, percent: 50, topLevel: true },
  ];
  for (const c of cases) {
    assert.equal(placementToArgs(c).includes(HELP_FLAG), false);
  }
});

test("computePlacementFromSnapshot: env 无效 → 最小 pane_id 兜底", () => {
  const panes = [pane(1, { rows: 5, cols: 5 }), pane(2, { rows: 10, cols: 9 })];
  // 兜底：env 无效 → 最小 pane_id(1) 推断 own → 分裂 pane 2（cols 9 > rows 10 为 false → bottom）
  const expected = { direction: "bottom", paneId: 2, percent: 50 };
  assert.deepEqual(computePlacementFromSnapshot(panes, ""), expected);
  assert.deepEqual(computePlacementFromSnapshot(panes, "abc"), expected);
  assert.deepEqual(computePlacementFromSnapshot(panes, undefined), expected);
});

test("computePlacementFromSnapshot: env 无效 + 空 panes → null", () => {
  assert.equal(computePlacementFromSnapshot([], undefined), null);
});

test("computePlacementFromSnapshot: 有效 env → 组合结果透传", () => {
  const panes = [
    pane(1, { rows: 4, cols: 5 }),
    pane(2, { rows: 9, cols: 10 }),
  ];
  assert.deepEqual(computePlacementFromSnapshot(panes, "1"), {
    direction: "right",
    paneId: 2,
    percent: 50,
  });
  // own 不在列表（env 指向不存在的 pane）→ computeGridPlacement null
  assert.equal(computePlacementFromSnapshot(panes, "99"), null);
});
