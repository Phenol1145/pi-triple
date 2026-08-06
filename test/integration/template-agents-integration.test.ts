import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("launcher 启动补写 AGENTS.md（幂等）", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ptl-launch-"));
  try {
    // 构造一个最小模板目录 + 配置
    const templateId = "tpl-0001";
    const tplDir = join(dataDir, "pi-config", templateId);
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(join(dataDir, "pi-triple.json"), JSON.stringify({
      templates: { [templateId]: { alias: "local" } },
    }));

    const { ensureTemplateAgents } = await import("../../src/ptl/template-agents.js");
    const alias = "local";
    ensureTemplateAgents(tplDir, templateId, alias);
    const first = readFileSync(join(tplDir, "AGENTS.md"), "utf-8");
    assert.equal(first.includes(templateId), true);
    // 幂等：再次调用不变化
    ensureTemplateAgents(tplDir, templateId, alias);
    const second = readFileSync(join(tplDir, "AGENTS.md"), "utf-8");
    assert.equal(second, first);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
