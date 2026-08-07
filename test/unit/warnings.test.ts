import { describe, it, expect } from "vitest";
import { isSqliteExperimentalWarning } from "@pi-triple/shared";

describe("isSqliteExperimentalWarning", () => {
  it("精确匹配 SQLite 实验警告", () => {
    expect(
      isSqliteExperimentalWarning({
        name: "ExperimentalWarning",
        message: "SQLite is an experimental feature and might change at any time",
      }),
    ).toBe(true);
  });

  it("其他警告不匹配（保留输出）", () => {
    expect(isSqliteExperimentalWarning({ name: "DeprecationWarning", message: "foo" })).toBe(false);
    expect(isSqliteExperimentalWarning({ name: "ExperimentalWarning", message: "Other experimental thing" })).toBe(false);
    expect(isSqliteExperimentalWarning({ name: "Warning", message: "SQLite mention but not experimental" })).toBe(false);
    expect(isSqliteExperimentalWarning({})).toBe(false);
  });
});
