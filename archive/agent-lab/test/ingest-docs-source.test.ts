import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DocsSource, parseDoc } from "../src/ingest/docs-source.ts";

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ingest-src-"));
  writeFileSync(path.join(dir, "a.md"), "# 标题 A\n\n第一段内容。\n\n后续段落。\n");
  mkdirSync(path.join(dir, "nested"));
  writeFileSync(path.join(dir, "nested", "b.md"), "无标题文档\n\n正文。\n");
  writeFileSync(path.join(dir, "nested", "pipe.md"), "# 含竖线|标题\n\n摘要|带竖线。\n");
  writeFileSync(path.join(dir, "long.md"), "# 长文\n\n" + "字".repeat(600) + "\n");
  writeFileSync(path.join(dir, "skip.txt"), "不是 markdown\n");
  return dir;
}

test("DocsSource 递归扫描仅 md、排序、title/firstPara 提取", () => {
  const dir = fixture();
  const docs = new DocsSource(dir).list();
  assert.deepEqual(docs.map((d) => d.relPath), ["a.md", "long.md", "nested/b.md", "nested/pipe.md"]);
  const a = docs.find((d) => d.relPath === "a.md")!;
  assert.equal(a.title, "标题 A");
  assert.equal(a.firstPara, "第一段内容。");
  const b = docs.find((d) => d.relPath === "nested/b.md")!;
  assert.equal(b.title, "b");           // 无 # 标题 → 文件名兜底
  assert.equal(b.firstPara, "无标题文档"); // 标题缺位时首段 = 首个非空行段落
  rmSync(dir, { recursive: true, force: true });
});

test("竖线替换为全角（EBNF 行内分字段兼容）", () => {
  const d = parseDoc("nested/pipe.md", "# 含竖线|标题\n\n摘要|带竖线。\n");
  assert.equal(d.title, "含竖线／标题");
  assert.equal(d.firstPara, "摘要／带竖线。");
});

test("firstPara 截断 500 字符", () => {
  const dir = fixture();
  const docs = new DocsSource(dir).list();
  const long = docs.find((d) => d.relPath === "long.md")!;
  assert.equal(long.firstPara.length, 500);
  rmSync(dir, { recursive: true, force: true });
});

test("contentHash 稳定且随内容变化", () => {
  const d1 = parseDoc("x.md", "# T\n\n正文。\n");
  const d2 = parseDoc("x.md", "# T\n\n正文。\n");
  const d3 = parseDoc("x.md", "# T\n\n正文改了。\n");
  assert.equal(d1.contentHash, d2.contentHash);
  assert.notEqual(d1.contentHash, d3.contentHash);
});
