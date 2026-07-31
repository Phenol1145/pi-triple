import { describe, it, expect } from "vitest";
import { layoutChart } from "../../src/ptl/tui-shared/chart.js";

describe("layoutChart", () => {
  it("输出行数 = height，含 y 轴刻度", () => {
    const { rows, yTicks } = layoutChart([0.5, 0.8], 40, 10);
    expect(rows).toHaveLength(10);
    expect(yTicks.length).toBeGreaterThanOrEqual(3);
  });

  it("平线数据仍渲染（max-min<0.01 不崩）", () => {
    const { rows } = layoutChart([0.7, 0.7, 0.7], 20, 6);
    expect(rows).toHaveLength(6);
    expect(rows.join("")).toContain("●");
  });

  it("单点数据渲染", () => {
    const { rows } = layoutChart([1], 10, 5);
    expect(rows.join("")).toContain("●");
  });

  it("空数组返回占位", () => {
    const { rows } = layoutChart([], 10, 5);
    expect(rows.join("")).toContain("no data");
  });
});
