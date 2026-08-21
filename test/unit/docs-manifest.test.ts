/**
 * docs-manifest.test.ts —— 文档分类清单与链接安全网。
 *
 * 第一阶段（先清单后搬迁）：
 *  - docs-manifest.json 必须覆盖 docs/ 内全部文档；
 *  - 全部仓库内相对链接必须可解析（后续物理搬迁不得破坏）。
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDocsEntries, type DocCategory } from "../../scripts/build-docs-manifest.js";
import { collectDocLinkIssues } from "../../scripts/check-doc-links.js";

const manifest = JSON.parse(readFileSync(resolve("docs/docs-manifest.json"), "utf8")) as {
  version: number;
  docs: Array<{ path: string; category: DocCategory; status: string }>;
};

describe("docs 分类清单", () => {
  it("manifest 覆盖 docs/ 全部文档且分类合法", () => {
    const current = collectDocsEntries();
    expect(manifest.version).toBe(1);
    expect(manifest.docs).toHaveLength(current.length);
    const byPath = new Map(manifest.docs.map((entry) => [entry.path, entry]));
    for (const entry of current) {
      expect(byPath.has(entry.path), `missing in manifest: ${entry.path}`).toBe(true);
      const listed = byPath.get(entry.path)!;
      expect(listed.category).toBe(entry.category);
      expect(["active", "reference", "historical"]).toContain(listed.status);
    }
    for (const entry of manifest.docs) {
      expect(() => statSync(entry.path)).not.toThrow();
    }
  });

  it("文档内相对链接全部可解析（搬迁安全网）", () => {
    expect(collectDocLinkIssues(["docs", "README.md", "ARCHITECTURE.md", "TODO.md"]), "broken doc links").toEqual([]);
  });
});
