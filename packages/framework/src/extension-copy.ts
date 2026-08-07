/**
 * extension/skill copy 双模式（spec §6.2 遮蔽机制）
 *
 * 环境 pi-config/<id>/{extensions,skills}/ 下的条目有两种形态：
 * - 引用模式（默认）：symlink → shared/{extensions,skills}/<name>——共享，一处修改处处生效
 * - 源码模式（--mode 源码/source）：本地实体复制，遮蔽共享 symlink——独立可改
 *
 * 遮蔽原理：shared-layer.linkTemplateToShared 建链接时跳过已存在条目
 * （lstat 存在即 continue），因此环境目录放实体（非 symlink）即遮蔽共享。
 *
 * 完成提示"会话内 /reload 生效"（spec §5）。
 */

import fs from "node:fs";
import path from "node:path";
import {
  loadConfig, resolveTemplateId, resolveDataDir,
  getTemplateAlias, getDefaultTemplateId, ERR,
} from "@pi-triple/shared";
import type { CommandResult } from "./commands.js";

export type CopyMode = "reference" | "source";

const KIND_LABEL: Record<"extensions" | "skills", string> = {
  extensions: "扩展",
  skills: "技能",
};

/** 归一化 --mode：源码|source → source；其余（含缺省）→ reference（引用为默认） */
export function normalizeCopyMode(mode: string | undefined): CopyMode {
  if (mode === "源码" || mode === "source") return "source";
  return "reference";
}

/** 从 rest 参数解析 --from/--mode（dispatch 通路；--flag value 成对消费） */
export function parseCopyOpts(args: string[]): { from?: string; mode?: string } {
  const opts: { from?: string; mode?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--from") opts.from = args[i + 1];
    else if (a === "--mode") opts.mode = args[i + 1];
  }
  return opts;
}

/** 解析目标环境 → pi-config/<id> 目录（别名/UUID 前缀；缺省用默认模板） */
async function resolveEnvDir(from: string | undefined): Promise<
  | { ok: true; envDir: string; alias: string; envId: string }
  | { ok: false; error: CommandResult }
> {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  const target = (from ?? "").trim() || getDefaultTemplateId(config);
  if (!target) {
    return { ok: false, error: { ok: false, message: "", error: { code: ERR.TENANT_NOT_FOUND, message: "未指定 --from 且无默认环境" } } };
  }
  const resolved = resolveTemplateId(target, config);
  if (!resolved.ok) {
    return { ok: false, error: { ok: false, message: "", error: { code: ERR.TENANT_NOT_FOUND, message: `环境 "${target}" 不存在` } } };
  }
  return { ok: true, envDir: path.join(dataDir, "pi-config", resolved.id), alias: getTemplateAlias(resolved.id, config), envId: resolved.id };
}

/** extension copy：引用（symlink 共享）vs 源码（实体遮蔽） */
export async function execExtensionCopy(name: string, opts: { from?: string; mode?: string } = {}): Promise<CommandResult> {
  return copyEntity("extensions", name, opts);
}

/** skill copy：与 extension 同机制（shared/skills → 环境 skills/） */
export async function execSkillCopy(name: string, opts: { from?: string; mode?: string } = {}): Promise<CommandResult> {
  return copyEntity("skills", name, opts);
}

async function copyEntity(kind: "extensions" | "skills", name: string, opts: { from?: string; mode?: string }): Promise<CommandResult> {
  const sub = kind === "extensions" ? "extension-copy" : "skill-copy";
  if (!name) {
    return { ok: false, message: "", error: { code: ERR.INTERACTIVE_REQUIRED, message: `用法: ptl env ${sub} <name> [--from <env>] [--mode 引用|源码]` } };
  }

  const env = await resolveEnvDir(opts.from);
  if (!env.ok) return env.error;

  const config = loadConfig();
  const sharedDir = path.resolve(process.cwd(), config.sharedDir);
  const sharedEntry = path.join(sharedDir, kind, name);
  if (!fs.existsSync(sharedEntry)) {
    return { ok: false, message: "", error: { code: "NOT_FOUND", message: `共享层 ${kind}/${name} 不存在（${sharedEntry}）` } };
  }

  const envSubDir = path.join(env.envDir, kind);
  const target = path.join(envSubDir, name);
  const mode = normalizeCopyMode(opts.mode);
  fs.mkdirSync(envSubDir, { recursive: true });

  const relTarget = path.relative(envSubDir, sharedEntry);
  const isDir = fs.lstatSync(sharedEntry).isDirectory();

  if (mode === "reference") {
    // 目标已存在：symlink → unlink 重链（防悬空）；实体 → 保守报错（不删用户副本）
    let existing: fs.Stats | null = null;
    try { existing = fs.lstatSync(target); } catch { /* 不存在 */ }
    if (existing && !existing.isSymbolicLink()) {
      return {
        ok: false, message: "",
        error: { code: "EXISTS", message: `环境 ${kind}/${name} 是实体（源码副本，遮蔽共享）——引用模式不覆盖用户数据，请先移除实体或改用源码模式` },
      };
    }
    if (existing) fs.unlinkSync(target); // 旧 symlink：刷新重链
    fs.symlinkSync(relTarget, target, isDir ? "dir" : "file");
    return {
      ok: true,
      message: `  ✅ 环境 "${env.alias}" 已引用共享${KIND_LABEL[kind]} "${name}"（symlink → shared/${kind}/${name}）\n  💡 会话内 /reload 生效（spec §5）`,
      data: { envId: env.envId, alias: env.alias, kind, name, mode: "reference", target, shared: sharedEntry, link: true },
    };
  }

  // 源码模式：实体复制（遮蔽共享 symlink）；目标已存在且为 symlink 先 unlink 再 cp
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) fs.unlinkSync(target);
  } catch { /* 不存在 */ }
  fs.cpSync(sharedEntry, target, { recursive: true, force: true });
  return {
    ok: true,
    message: `  ✅ 环境 "${env.alias}" 已复制共享${KIND_LABEL[kind]} "${name}" 为本地实体（遮蔽共享，独立可改）\n  💡 会话内 /reload 生效（spec §5）`,
    data: { envId: env.envId, alias: env.alias, kind, name, mode: "source", target, shared: sharedEntry, link: false },
  };
}
