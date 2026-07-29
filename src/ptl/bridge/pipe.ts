/**
 * bridge/pipe.ts — 将 agent 程序的 systemPrompt + skills 注入 pi 启动参数
 *
 * 与 pit run 语义对称：本地调试时用相同 manifest → launchPi。
 */
import fs from "node:fs";
import path from "node:path";
import { launchPi, buildPiLaunch } from "../launcher.js";
import { loadConfig, resolveTemplateId, getDefaultTemplateId } from "../config.js";
import type { ProgramManifest } from "./manifest.js";

export async function pipeToProcess(
  absDir: string,
  manifest: ProgramManifest,
  passthrough: string[],
  flags: Record<string, string>,
): Promise<void> {
  const config = loadConfig();
  // Use --tenant or default
  const resolved = flags.tenant
    ? resolveTemplateId(flags.tenant, config)
    : null;
  const templateId = (resolved?.ok ? resolved.id : null) ?? getDefaultTemplateId(config);
  const templateConfig = config.templates[templateId] ?? {};

  // Build extraArgs: --append-system-prompt + --skill for each skill
  const extraArgs: string[] = [];

  if (manifest.systemPrompt) {
    const promptPath = path.resolve(absDir, manifest.systemPrompt);
    if (fs.existsSync(promptPath)) {
      extraArgs.push("--append-system-prompt", promptPath);
    }
  }

  if (manifest.skills) {
    for (const skillRel of manifest.skills) {
      const skillPath = path.resolve(absDir, skillRel);
      if (fs.existsSync(skillPath)) {
        extraArgs.push("--skill", skillPath);
      }
    }
  }

  // Passthrough args (e.g. -c for continue)
  extraArgs.push(...passthrough);

  const code = await launchPi({
    templateId,
    project: flags.project,
    provider: manifest.provider ?? templateConfig.provider,
    model: manifest.model ?? templateConfig.model,
    thinking: manifest.thinking ?? templateConfig.thinking,
    tools: manifest.tools?.join(","),
    excludeTools: manifest.excludeTools?.join(","),
    extraArgs,
  });

  process.exit(code);
}
