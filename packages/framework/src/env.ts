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
 * - fork：复制源配方引用（model/skills/extensions 等字段继承，实体不复制，独立可改）
 *
 * 全部返回 CommandResult（ok/message/data），对齐 commands.ts 的 execTemplate 系列。
 */

import fs from "node:fs";
import path from "node:path";
import {
  loadConfig, resolveTemplateId,
  listTemplates, saveConfig, ERR,
  createTemplate, getTemplateAlias, resolveDataDir,
} from "@away_from/shared";
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
  // Finding #1 防御：--model y 等 flag 形式会被 args.ts VALUED_FLAGS 吞掉，
  // 不进 passthrough → parseEnvPatch([]) 空 patch。空 patch 必须报错，
  // 否则 set 成功但零修改（静默假阳性）。报错先于租户解析（用法错误优先）。
  if (Object.keys(patch).length === 0) {
    return { ok: false, message: "", error: { code: "INVALID_ARGS", message: "未提供任何字段，请用 field=value 形式（如 model=qwen3.8-max）" } };
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

/**
 * 派生环境（fork）：复制源模板的完整配方引用，不复制实体。
 *
 * 语义（spec §6.1）：
 * - 配方字段（TemplateConfig 全字段：model/provider/thinking/tools/excludeTools/
 *   systemPrompt/skills/extensions/workLoop/instantiation）浅复制到新 template 记录——
 *   引用共享，实体（扩展/skill 文件、共享层）不复制
 * - 独立性：配方落在新记录上，后续 set 新环境只改自己的字段，不影响源
 * - 建目录 + 共享层链接 + AGENTS.md + migrate：与 execTemplateNew 相同流程
 *
 * 返回 {id, alias, recipe}（--json 可编程）。
 */
export async function execEnvFork(newAlias: string, srcAlias: string): Promise<CommandResult> {
  if (!newAlias || !srcAlias) {
    return { ok: false, message: "", error: { code: ERR.INTERACTIVE_REQUIRED, message: "用法: ptl env fork <新别名> <源别名>" } };
  }
  const config = loadConfig();
  const resolved = resolveTemplateId(srcAlias, config);
  if (!resolved.ok) {
    return { ok: false, message: "", error: { code: ERR.TENANT_NOT_FOUND, message: `环境 "${srcAlias}" 不存在` } };
  }
  const src = config.templates[resolved.id]!;
  // 复制配方引用（recipeOf 只取已定义配方字段；浅复制——数组/对象引用共享，实体不复制）
  const recipe = recipeOf(src as unknown as Record<string, unknown>);
  return materializeEnv(newAlias, recipe);
}

/**
 * 建模板实体：createTemplate(配方) + 目录 + 共享层链接 + AGENTS.md + migrate。
 * 镜像 execTemplateNew 的建模板流程（其内部逻辑未导出且硬编码空配方，
 * fork 需带配方创建，故在此内联——后续可提取公共 helper 收敛两处）。
 */
async function materializeEnv(alias: string, recipe: Record<string, unknown>): Promise<CommandResult> {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);

  try {
    const id = createTemplate(alias, recipe, config);
    const templateDir = path.join(dataDir, "pi-config", id);

    // 显式创建模板目录：共享层缺失时 templateDir 无其他创建者
    fs.mkdirSync(templateDir, { recursive: true });

    const displayAlias = getTemplateAlias(id, config);

    // Check shared layer
    let sharedMsg = "";
    let sharedLinked = false;
    const sharedDirPath = path.resolve(process.cwd(), config.sharedDir);
    if (fs.existsSync(sharedDirPath)) {
      const { linkTemplateToShared } = await import("./shared-layer.js");
      linkTemplateToShared(templateDir, sharedDirPath);
      sharedLinked = true;
      sharedMsg = "\n  ✅ 已链接共享层";
    }

    // 写入 AGENTS.md 认知注入（pi 原生机制）
    const { ensureTemplateAgents } = await import("@away_from/shared");
    const agentsWritten = ensureTemplateAgents(templateDir, id, displayAlias);
    if (agentsWritten) sharedMsg += "\n  ✅ 已写入 AGENTS.md（PTL 认知注入）";

    // Auto-migrate if pi config exists（首次安装无 ~/.pi/agent 时静默跳过）
    let migrated = false;
    if (!fs.existsSync(path.join(templateDir, "settings.json"))) {
      const { migrate } = await import("./migrate.js");
      await migrate({ templateId: id, quietIfNoSource: true });
      migrated = true;
    }

    return {
      ok: true,
      message: `  ✅ 环境已派生: ${displayAlias} (${id.slice(0, 8)}…)${sharedMsg}`,
      data: {
        id,
        alias: displayAlias,
        recipe: recipeOf(config.templates[id] as unknown as Record<string, unknown>),
        migrated,
        sharedLinked,
        agentsMd: agentsWritten,
      },
    };
  } catch (err: any) {
    if (err.message?.startsWith("别名")) {
      return { ok: false, message: "", error: { code: ERR.INTERACTIVE_REQUIRED, message: err.message } };
    }
    throw err;
  }
}
