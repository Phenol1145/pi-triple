/**
 * Pi-Triple env 命令族 — 环境（= 模板）的自主创建/查询/配置
 *
 * env 与 template 是同一实体（TemplateConfig 即"配方"）：
 * - create：fresh 空配方（不继承任何预设），复用 execTemplateNew 的
 *   建目录/共享层链接/AGENTS.md/migrate 流程
 * - list/show：配方查询（data 机器可读，--json 可编程）
 * - set：配方字段合并（TemplateConfig: model/provider/thinking/tools/
 *   excludeTools/systemPrompt/skills/extensions/workLoop/instantiation）
 * - rm：复用 execTemplateRm（运行中会话保护 + 级联删除）
 *
 * 全部返回 CommandResult（ok/message/data），对齐 commands.ts 的 execTemplate 系列。
 */

import {
  loadConfig, resolveTemplateId,
  listTemplates, saveConfig, ERR,
} from "@pi-triple/shared";
import { execTemplateNew, execTemplateRm, type CommandResult } from "./commands.js";

/** env set 可写配方字段（TemplateConfig 全配方字段；alias 是身份字段，改名走 template rename） */
const ENV_WRITABLE = new Set([
  "model", "provider", "thinking", "tools", "excludeTools",
  "systemPrompt", "skills", "extensions", "workLoop", "instantiation",
]);

/** 配方字段输出顺序（show/list 用） */
const RECIPE_KEYS = [...ENV_WRITABLE];

/** 提取配方（仅已定义字段） */
function recipeOf(tpl: Record<string, unknown>): Record<string, unknown> {
  const recipe: Record<string, unknown> = {};
  for (const k of RECIPE_KEYS) {
    if (tpl[k] !== undefined) recipe[k] = tpl[k];
  }
  return recipe;
}

/** 解析 env set 的 k=v 参数（值尝试 JSON 解析，失败回落为字符串） */
export function parseEnvPatch(args: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const arg of args) {
    const idx = arg.indexOf("=");
    if (idx > 0) {
      const key = arg.slice(0, idx).trim();
      if (!key) continue;
      patch[key] = coerceValue(arg.slice(idx + 1));
    }
  }
  // 兼容 "set <alias> <key> <value>" 两参形式（对齐 flow set）
  const bare = args.filter((a) => !a.includes("="));
  if (bare.length === 2 && !(bare[0] in patch)) {
    patch[bare[0]] = coerceValue(bare[1]);
  }
  return patch;
}

function coerceValue(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

// ─── Commands ────────────────────────────────────────────────

/**
 * 创建环境：fresh 空配方（不继承任何预设）。
 * opts 预留（当前仅支持空配方创建，非空配方走 create 后 set）。
 */
export async function execEnvCreate(alias: string, _opts: Record<string, unknown> = {}): Promise<CommandResult> {
  return execTemplateNew(alias);
}

/** 列出全部环境（配方摘要；data.envs 机器可读） */
export async function execEnvList(): Promise<CommandResult> {
  const config = loadConfig();
  const templates = listTemplates(config);
  const envs = templates.map((t) => ({
    id: t.id,
    alias: t.alias,
    isDefault: t.isDefault,
    recipe: recipeOf(t.config as unknown as Record<string, unknown>),
  }));

  if (envs.length === 0) {
    return { ok: true, message: "(无环境，运行 ptl env create <alias> 创建)", data: { envs: [] } };
  }

  const lines = envs.map((e) => {
    const model = e.recipe.model ? `model: ${e.recipe.model}` : "(默认模型)";
    return `  ${e.isDefault ? "*" : " "} \x1b[1m${e.alias}\x1b[0m  ${model}`;
  });
  return { ok: true, message: lines.join("\n"), data: { envs } };
}

/** 查看环境完整配方 */
export async function execEnvShow(alias: string): Promise<CommandResult> {
  if (!alias) {
    return { ok: false, message: "", error: { code: ERR.INTERACTIVE_REQUIRED, message: "用法: ptl env show <alias>" } };
  }
  const config = loadConfig();
  const resolved = resolveTemplateId(alias, config);
  if (!resolved.ok) {
    return { ok: false, message: "", error: { code: ERR.TENANT_NOT_FOUND, message: `环境 "${alias}" 不存在` } };
  }
  const tpl = config.templates[resolved.id]!;
  const recipe = recipeOf(tpl as unknown as Record<string, unknown>);
  const lines = [
    `  ${tpl.alias} (${resolved.id.slice(0, 8)}…)`,
    ...RECIPE_KEYS.filter((k) => recipe[k] !== undefined).map((k) => `  ${k}: ${JSON.stringify(recipe[k])}`),
  ];
  return { ok: true, message: lines.join("\n"), data: { id: resolved.id, alias: tpl.alias, recipe } };
}

/** 修改环境配方字段（合并 patch；不可写字段报错） */
export async function execEnvSet(alias: string, patch: Record<string, unknown> = {}): Promise<CommandResult> {
  if (!alias) {
    return { ok: false, message: "", error: { code: ERR.INTERACTIVE_REQUIRED, message: "用法: ptl env set <alias> <field=value...>" } };
  }
  const invalid = Object.keys(patch).filter((k) => !ENV_WRITABLE.has(k));
  if (invalid.length > 0) {
    return { ok: false, message: "", error: { code: "INVALID_ARGS", message: `不可写字段: ${invalid.join(", ")}（可用: ${[...ENV_WRITABLE].join(", ")}）` } };
  }
  const config = loadConfig();
  const resolved = resolveTemplateId(alias, config);
  if (!resolved.ok) {
    return { ok: false, message: "", error: { code: ERR.TENANT_NOT_FOUND, message: `环境 "${alias}" 不存在` } };
  }
  const tpl = config.templates[resolved.id]!;
  for (const [k, v] of Object.entries(patch)) {
    (tpl as any)[k] = v;
  }
  saveConfig(config);
  const recipe = recipeOf(tpl as unknown as Record<string, unknown>);
  const changed = Object.keys(patch).map((k) => `${k}=${JSON.stringify(patch[k])}`).join(", ");
  return { ok: true, message: `  ✅ 环境 "${tpl.alias}" 已更新: ${changed}`, data: { id: resolved.id, alias: tpl.alias, recipe } };
}

/** 删除环境（复用 execTemplateRm：运行中会话保护 + 级联删除） */
export async function execEnvRm(alias: string): Promise<CommandResult> {
  return execTemplateRm(alias);
}
