import { describe, it, expect } from "vitest";
// useTableSelection 的移动逻辑抽纯函数（hook 薄壳）
import { tableNextIndex } from "../../src/ptl/tui-shared/hooks.js";

describe("tableNextIndex", () => {
  it("边界钳制", () => {
    expect(tableNextIndex(0, -1, 3)).toBe(0);
    expect(tableNextIndex(2, 1, 3)).toBe(2);
    expect(tableNextIndex(1, 1, 3)).toBe(2);
  });
});
