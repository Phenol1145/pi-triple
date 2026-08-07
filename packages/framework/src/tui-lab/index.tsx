#!/usr/bin/env node
/**
 * tui-lab — Agent Lab Monitor 入口
 *
 * 用法：
 *   ptl lab                   # 默认模板 + Telemetry 本模板
 *   ptl lab --tenant dev      # 指定模板
 *   ptl lab --global          # Telemetry 全局，Arena/Events 仍需选模板
 */

import { render } from "ink";
import { LabApp } from "./app.js";
import { loadConfig, getDefaultTemplateId, resolveTemplateId, getTemplateAlias } from "@pi-triple/shared";

const args = process.argv.slice(2);

let templateId: string;
let globalTelemetry = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--tenant" && args[i + 1]) {
    const config = loadConfig();
    const resolved = resolveTemplateId(args[++i], config);
    if (resolved.ok) {
      templateId = resolved.id;
    } else if (resolved.reason === "ambiguous") {
      console.error(`Ambiguous tenant "${resolved.input}". Candidates: ${resolved.candidates.map((c) => {
        const alias = config.templates[c]?.alias ?? c.slice(0, 8);
        return `${alias} (${c.slice(0, 8)}…)`;
      }).join(", ")}`);
      console.error("Use a longer UUID prefix or the full UUID.");
      process.exit(1);
    } else {
      console.error(`Unknown tenant: ${resolved.input}`);
      process.exit(1);
    }
  }
  if (args[i] === "--global") {
    globalTelemetry = true;
  }
}

if (!templateId!) {
  const config = loadConfig();
  templateId = getDefaultTemplateId(config);
}

const alias = (() => {
  try {
    const config = loadConfig();
    return getTemplateAlias(templateId, config);
  } catch {
    return templateId.slice(0, 8);
  }
})();

render(
  <LabApp templateId={templateId} templateAlias={alias} globalTelemetry={globalTelemetry} />,
  { exitOnCtrlC: false },
);
