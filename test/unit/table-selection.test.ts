import { describe, it, expect } from "vitest";
// useTableSelection 的移动逻辑抽纯函数（hook 薄壳）
import { tableNextIndex, tableWindow } from "../../packages/framework/src/tui-shared/hooks.js";

describe("tableNextIndex", () => {
  it("边界钳制", () => {
    expect(tableNextIndex(0, -1, 3)).toBe(0);
    expect(tableNextIndex(2, 1, 3)).toBe(2);
    expect(tableNextIndex(1, 1, 3)).toBe(2);
  });
});

describe("tableWindow", () => {
  const rows = [0, 1, 2, 3, 4];

  it("未超上限 → 全量返回，offset 0", () => {
    expect(tableWindow(rows, 2, 10)).toEqual({ rows, offset: 0 });
    expect(tableWindow(rows, 0, 5)).toEqual({ rows, offset: 0 });
  });

  it("超上限 → 窗口滚动到选中行", () => {
    expect(tableWindow(rows, 0, 2)).toEqual({ rows: [0, 1], offset: 0 });
    expect(tableWindow(rows, 2, 2)).toEqual({ rows: [2, 3], offset: 2 });
    expect(tableWindow(rows, 4, 2)).toEqual({ rows: [3, 4], offset: 3 });
  });

  it("空列表/非法 cap 安全", () => {
    expect(tableWindow([], 0, 2)).toEqual({ rows: [], offset: 0 });
    expect(tableWindow(rows, 2, 0)).toEqual({ rows, offset: 0 });
  });
});
