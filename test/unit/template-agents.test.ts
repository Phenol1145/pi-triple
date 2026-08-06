import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplateAgents, ensureTemplateAgents, AGENTS_TPL_PATH } from "../../src/ptl/template-agents.js";

const TPL = `# 你是 PTL 模板环境中的 pi agent
- 当前模板：<templateId>（别名 <alias>）`;

test("renderTemplateAgents 替换两个占位符", () => {
  const out = renderTemplateAgents(TPL, "abc-123", "local");
  assert.equal(out.includes("abc-123"), true);
  assert.equal(out.includes("local"), true);
  assert.equal(out.includes("<templateId>"), false);
  assert.equal(out.includes("<alias>"), false);
});

test("ensureTemplateAgents 写入并返回 true", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptl-agents-"));
  try {
    const tplFile = join(dir, "tpl.md");
    writeFileSync(tplFile, TPL);
    const written = ensureTemplateAgents(dir, "abc-123", "local", tplFile);
    assert.equal(written, true);
    const content = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    assert.equal(content.includes("abc-123"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureTemplateAgents 内容未变时返回 false（幂等）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptl-agents-"));
  try {
    const tplFile = join(dir, "tpl.md");
    writeFileSync(tplFile, TPL);
    ensureTemplateAgents(dir, "abc-123", "local", tplFile);
    const second = ensureTemplateAgents(dir, "abc-123", "local", tplFile);
    assert.equal(second, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AGENTS_TPL_PATH 指向仓库内模板文件", () => {
  assert.equal(existsSync(AGENTS_TPL_PATH), true);
});
