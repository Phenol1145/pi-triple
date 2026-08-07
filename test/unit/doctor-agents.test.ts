import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTemplateAgentsMd } from "../../packages/framework/src/doctor-agents.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ptl-doctor-"));
}

describe("checkTemplateAgentsMd — AGENTS.md 认知注入检查", () => {
  it("AGENTS.md 缺失时报告 ok=false", () => {
    const dir = tmpDir();
    try {
      const r = checkTemplateAgentsMd(dir);
      expect(r.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AGENTS.md 残留占位符时报告 ok=false", () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# 残留 <templateId>");
      const r = checkTemplateAgentsMd(dir);
      expect(r.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AGENTS.md 正常时报告 ok=true", () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# 正常内容，无占位符");
      const r = checkTemplateAgentsMd(dir);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
