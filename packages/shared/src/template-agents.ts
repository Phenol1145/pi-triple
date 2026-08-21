import fs from "node:fs";
import path from "node:path";

/** 包内 AGENTS.md 模板源（src 与 dist 同级解析到 packages/shared/docs——npm 包 files 同时带 docs，发布后同样可用） */
export const AGENTS_TPL_PATH = path.resolve(import.meta.dirname, "../docs/ptl/templates/AGENTS.md.tpl");

export function renderTemplateAgents(tplContent: string, templateId: string, alias: string): string {
  return tplContent
    .replaceAll("<templateId>", templateId)
    .replaceAll("<alias>", alias);
}

/**
 * 确保模板目录存在 AGENTS.md。目标缺失或与模板源不一致时写入。
 * @returns 是否执行了写入
 */
export function ensureTemplateAgents(
  templateDir: string,
  templateId: string,
  alias: string,
  tplPath: string = AGENTS_TPL_PATH,
): boolean {
  const target = path.join(templateDir, "AGENTS.md");
  const tpl = fs.readFileSync(tplPath, "utf-8");
  const rendered = renderTemplateAgents(tpl, templateId, alias);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf-8");
    if (existing === rendered) return false;
  }
  fs.writeFileSync(target, rendered);
  return true;
}
