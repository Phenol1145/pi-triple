import fs from "node:fs";
import path from "node:path";

export interface AgentsMdCheck {
  ok: boolean;
  detail?: string;
}

/** 检查模板目录 AGENTS.md 存在且无占位符残留 */
export function checkTemplateAgentsMd(templateDir: string): AgentsMdCheck {
  const target = path.join(templateDir, "AGENTS.md");
  if (!fs.existsSync(target)) {
    return { ok: false, detail: "AGENTS.md 缺失（运行 ptl template new 或启动会话补写）" };
  }
  const content = fs.readFileSync(target, "utf-8");
  if (content.includes("<templateId>") || content.includes("<alias>")) {
    return { ok: false, detail: "AGENTS.md 含未渲染占位符（需重新 ensureTemplateAgents）" };
  }
  return { ok: true };
}
