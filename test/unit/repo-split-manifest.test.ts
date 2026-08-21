/**
 * repo-split-manifest.test.ts —— 三仓拆分清单一致性（设计阶段，不搬文件）。
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(resolve("docs/repo-split-v15-manifest.json"), "utf8")) as {
  version: number;
  repos: Record<string, { filterRepoPaths: string[]; postFilterRemovePaths: string[]; workspaces: string[] }>;
  commandMigrations: Array<{ from: string; to: string; kind: "pth" | "ptl-local" }>;
  decisions: Record<string, unknown>;
};

describe("repo split manifest（设计阶段）", () => {
  it("三仓拓扑与关键归属正确", () => {
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.repos).sort()).toEqual(["deps", "pth", "ptl"]);
    expect(manifest.repos.deps!.workspaces).toEqual(["packages/shared", "packages/infra"]);
    expect(manifest.repos.pth!.filterRepoPaths).toContain("packages/pth-console");
    expect(manifest.repos.pth!.filterRepoPaths).toContain("src/pth");
    expect(manifest.repos.ptl!.filterRepoPaths).toContain("packages/framework");
    expect(manifest.repos.ptl!.filterRepoPaths).not.toContain("packages/pth-console");
    expect(manifest.decisions.ptlHub).toContain("retired");
  });

  it("路径清单中的字面路径都存在", () => {
    for (const repo of Object.values(manifest.repos)) {
      for (const path of [...repo.filterRepoPaths, ...repo.postFilterRemovePaths]) {
        if (path.includes("*")) continue;
        expect(() => statSync(path), `${repo === manifest.repos.ptl ? "ptl" : "other"} missing ${path}`).not.toThrow();
      }
    }
  });

  it("PTL 的 test/unit 二次剔除覆盖 PTH/deps 单元测试", () => {
    const pthUnitTests = manifest.repos.pth!.filterRepoPaths.filter((path) => path.startsWith("test/unit/"));
    const depsUnitTests = manifest.repos.deps!.filterRepoPaths.filter((path) => path.startsWith("test/unit/"));
    const remove = new Set(manifest.repos.ptl!.postFilterRemovePaths);
    for (const path of [...pthUnitTests, ...depsUnitTests]) {
      expect(remove.has(path), `ptl must post-filter ${path}`).toBe(true);
    }
  });

  it("命令迁移映射覆盖原 ptl hub 全部 PTH 交互面且无重复", () => {
    const froms = manifest.commandMigrations.map((entry) => entry.from);
    expect(new Set(froms).size).toBe(froms.length);
    expect(froms.join("\n")).toContain("ptl hub kernel");
    expect(froms.join("\n")).toContain("ptl hub lineage");
    expect(froms.join("\n")).toContain("ptl hub submit");
    expect(manifest.commandMigrations.some((entry) => entry.kind === "ptl-local")).toBe(true);
    for (const entry of manifest.commandMigrations) {
      expect(entry.to.length).toBeGreaterThan(0);
      expect(entry.impl).toContain("→");
    }
  });
});
