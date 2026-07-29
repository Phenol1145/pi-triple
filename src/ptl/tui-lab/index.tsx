#!/usr/bin/env node
/**
 * tui-lab — Agent Lab Monitor 入口
 *
 * 用法：
 *   pit lab                   # 默认租户 + Telemetry 本租户
 *   pit lab --tenant dev      # 指定租户
 *   pit lab --global          # Telemetry 全局，Arena/Events 仍需选租户
 */

import { render } from "ink";
import { LabApp } from "./app.js";
import { loadConfig, getDefaultTemplateId, resolveTemplateId, getTemplateAlias } from "../config.js";

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
