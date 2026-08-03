// pi-fork.ts — Pi 纸带会话写侧：fork/clone/transfer/branch（forkSessionAtNode）
// 谱系契约（session-format.md）：fork/clone 写 parentSession=<源文件>；
// transfer 保留 parentSession 只更新 cwd；branch 从 root→node 主线提取新会话。
// 注意：本模块只 import commands.js 的 CommandResult 类型（避免命令层循环依赖）。
import fs from "node:fs";
import path from "node:path";
import type { CommandResult } from "../commands.js";
import type { PiSessionFile } from "./pi-scan.js";
import { scanSessionFiles } from "./pi-scan.js";
import { uuidv7 } from "./uuidv7.js";
import type { ForkOpts, BranchOpts, TransferOpts } from "./session-provider.js";
import { resolveTemplateId, loadConfig } from "../config.js";

interface SessionHeader {
  type: string;
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

function readEntries(file: string): { header: SessionHeader; entries: any[]; skipped: number } | null {
  try {
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;
    const header = JSON.parse(lines[0]!) as SessionHeader;
    if (header.type !== "session" || typeof header.id !== "string") return null;
    const entries: any[] = [];
    let skipped = 0;
    for (const l of lines.slice(1)) {
      try { entries.push(JSON.parse(l)); } catch { skipped++; } // 单行损坏跳过（双写者/截断容忍）
    }
    return { header, entries, skipped };
  } catch {
    return null;
  }
}

function newFileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 从源文件推导 dataDir：<dataDir>/sessions/<tpl>/<file> → dirname×3 */
function dataDirOf(source: PiSessionFile): string {
  return path.dirname(path.dirname(path.dirname(source.file)));
}

type TargetResult =
  | { ok: true; templateId: string; cwd: string; dir: string }
  | { ok: false; error: CommandResult };

/**
 * 解析目标模板：缺省 = 源模板（cwd 保持）；显式 --template 时
 * 先走配置解析（别名/UUID/前缀），配置未命中则按目录存在性兜底
 * （<dataDir>/sessions/<requested> 存在即视为有效模板，测试/adhoc 目录）。
 * 目标模板 ≠ 源模板时 cwd 更新为 <dataDir>/workspaces/<tpl>/default。
 */
function resolveTarget(source: PiSessionFile, opts: ForkOpts | TransferOpts): TargetResult {
  const requested = "templateId" in opts ? opts.templateId : undefined;
  const sessionsRoot = path.dirname(path.dirname(source.file));

  let templateId = source.templateId;
  if (requested != null && requested !== source.templateId) {
    const cfg = loadConfig();
    const resolved = resolveTemplateId(requested, cfg);
    if (resolved.ok) {
      templateId = resolved.id;
    } else if (fs.existsSync(path.join(sessionsRoot, requested))) {
      templateId = requested;
    } else {
      return {
        ok: false,
        error: { ok: false, message: "", error: { code: "TEMPLATE_NOT_FOUND", message: `模板 "${requested}" 不存在（pit template ls 查看）` } },
      };
    }
  }

  const dir = path.join(sessionsRoot, templateId);
  fs.mkdirSync(dir, { recursive: true });
  const cwd = templateId === source.templateId
    ? source.cwd
    : path.join(dataDirOf(source), "workspaces", templateId, "default");
  return { ok: true, templateId, cwd, dir };
}

type WriteResult = { ok: true; file: string; id: string } | { ok: false; error: CommandResult };

/** 写新会话文件：uuidv7 id、version 3、wx 防覆盖；parentSession 有值才写 */
function writeNewSession(dir: string, cwd: string, parentSession: string | undefined, entries: any[]): WriteResult {
  const id = uuidv7();
  const ts = new Date().toISOString();
  const file = path.join(dir, `${newFileTimestamp()}_${id}.jsonl`);
  const header: SessionHeader = { type: "session", version: 3, id, timestamp: ts, cwd };
  if (parentSession) header.parentSession = parentSession;
  try {
    const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))];
    fs.writeFileSync(file, lines.join("\n") + "\n", { flag: "wx" });
    return { ok: true, file, id };
  } catch (err: any) {
    return { ok: false, error: { ok: false, message: "", error: { code: "WRITE_FAILED", message: `写入会话文件失败: ${err?.message ?? err}` } } };
  }
}

/** fork：新 header（parentSession=源文件）+ 复制全部非 header 条目 */
export function forkSession(source: PiSessionFile, opts: ForkOpts): CommandResult {
  const parsed = readEntries(source.file);
  if (!parsed) return { ok: false, message: "", error: { code: "SESSION_NOT_FOUND", message: `会话文件无效或不可读: ${source.file}` } };
  const warned = parsed.skipped > 0 ? `（跳过 ${parsed.skipped} 行损坏数据）` : "";
  const target = resolveTarget(source, opts);
  if (!target.ok) return target.error;
  const written = writeNewSession(target.dir, target.cwd, source.file, parsed.entries);
  if (!written.ok) return written.error;
  return {
    ok: true,
    message: `✅ 已 fork 会话 ${source.id.slice(0, 8)}… → ${path.basename(written.file)}${warned}`,
    data: { file: written.file, id: written.id },
  };
}

/** clone：与官方 /clone 对齐 —— 同样写 parentSession（谱系保留，与 fork 一致） */
export function cloneSession(source: PiSessionFile, opts: ForkOpts): CommandResult {
  const parsed = readEntries(source.file);
  if (!parsed) return { ok: false, message: "", error: { code: "SESSION_NOT_FOUND", message: `会话文件无效或不可读: ${source.file}` } };
  const warned = parsed.skipped > 0 ? `（跳过 ${parsed.skipped} 行损坏数据）` : "";
  const target = resolveTarget(source, opts);
  if (!target.ok) return target.error;
  const written = writeNewSession(target.dir, target.cwd, source.file, parsed.entries);
  if (!written.ok) return written.error;
  return {
    ok: true,
    message: `✅ 已克隆会话 ${source.id.slice(0, 8)}… → ${path.basename(written.file)}${warned}`,
    data: { file: written.file, id: written.id },
  };
}

/**
 * transfer：新 header 只更新 cwd（parentSession 保留），写入目标模板后
 * 删除源文件；目标模板存在同 id 会话 → ALREADY_EXISTS（防静默覆盖）。
 */
export function transferSession(source: PiSessionFile, opts: TransferOpts): CommandResult {
  const parsed = readEntries(source.file);
  if (!parsed) return { ok: false, message: "", error: { code: "SESSION_NOT_FOUND", message: `会话文件无效或不可读: ${source.file}` } };
  const warned = parsed.skipped > 0 ? `（跳过 ${parsed.skipped} 行损坏数据）` : "";
  const target = resolveTarget(source, opts);
  if (!target.ok) return target.error;
  if (target.templateId === source.templateId) {
    return { ok: false, message: "", error: { code: "TEMPLATE_NOT_FOUND", message: `目标模板与源模板相同（${source.templateId}），无需转移` } };
  }
  // 同 id 会话已存在于目标模板 → 拒绝（不按文件名判重，按会话 id）
  const existing = scanSessionFiles(dataDirOf(source)).find((f) => f.id === source.id && f.templateId === target.templateId);
  if (existing) {
    return { ok: false, message: "", error: { code: "ALREADY_EXISTS", message: `目标模板 ${target.templateId} 已存在同 id 会话文件，拒绝覆盖` } };
  }
  const destFile = path.join(target.dir, path.basename(source.file));
  try {
    const header: SessionHeader = { ...parsed.header, cwd: target.cwd };
    const lines = [JSON.stringify(header), ...parsed.entries.map((e) => JSON.stringify(e))];
    fs.writeFileSync(destFile, lines.join("\n") + "\n", { flag: "wx" });
    fs.rmSync(source.file); // 写入成功才删源（回滚安全）
    return {
      ok: true,
      message: `✅ 已转移会话 ${source.id.slice(0, 8)}… → 模板 ${target.templateId}${warned}`,
      data: { file: destFile },
    };
  } catch (err: any) {
    return { ok: false, message: "", error: { code: "WRITE_FAILED", message: `转移失败（源文件未动）: ${err?.message ?? err}` } };
  }
}

/**
 * branch：root→node 主线提取（parentId 链回溯，含 node 不含后代）。
 * - label 过滤并重链 parentId（官方 createBranchedSession 的 pathWithoutLabels 模式）
 * - 直接挂在主线上的 compaction 按文件序并入（保留压缩点），
 *   firstKeptEntryId 引用不在主线时删除该字段（完整性检查）
 * - 重建 label entries：targetId 在主线内的 label 追加到链尾，
 *   parentId = 最后一个主线 id，新 id 用 `${原id}-r` 后缀防碰撞
 */
export function forkSessionAtNode(source: PiSessionFile, opts: BranchOpts): CommandResult {
  const parsed = readEntries(source.file);
  if (!parsed) return { ok: false, message: "", error: { code: "SESSION_NOT_FOUND", message: `会话文件无效或不可读: ${source.file}` } };
  const warned = parsed.skipped > 0 ? `（跳过 ${parsed.skipped} 行损坏数据）` : "";
  const byId = new Map(parsed.entries.map((e) => [e.id as string, e]));
  const node = byId.get(opts.at);
  if (!node) {
    return { ok: false, message: "", error: { code: "NODE_NOT_FOUND", message: `节点 "${opts.at}" 不存在（pit session branch --list-nodes 查看）` } };
  }

  // 沿 parentId 链回溯到 root，收集主线（node 含；后代不含）
  const chain: any[] = [];
  const seen = new Set<string>();
  let cur: any = node;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse(); // root → node

  // 过滤 label（稍后重建）：主线 id 集合 = 链上非 label 条目
  const mainlineIds = new Set<string>();
  for (const entry of chain) {
    if (entry.type !== "label") mainlineIds.add(entry.id);
  }

  // 按文件序重链主线 + 并入直接挂在主线上的 compaction（保留压缩点）
  const finalPath: any[] = [];
  let lastId: string | null = null;
  for (const entry of parsed.entries) {
    if (entry.type === "label") continue; // label 统一重建
    if (mainlineIds.has(entry.id)) {
      finalPath.push({ ...entry, parentId: lastId });
      lastId = entry.id;
    } else if (entry.type === "compaction" && entry.parentId != null && mainlineIds.has(entry.parentId)) {
      // compaction 父在主线、自身不在链上：按文件序并入并重链
      finalPath.push({ ...entry, parentId: lastId });
      lastId = entry.id;
    }
    // 其余（分支后代、悬空）丢弃
  }

  // compaction 完整性：firstKeptEntryId 引用必须在主线内，否则删除该字段
  for (const entry of finalPath) {
    if (entry.type === "compaction" && entry.firstKeptEntryId != null && !mainlineIds.has(entry.firstKeptEntryId)) {
      delete entry.firstKeptEntryId;
    }
  }

  // 重建 label entries（路径上带 label 的 targetId）
  const lastEntryId = finalPath[finalPath.length - 1]?.id ?? null;
  const labelsToWrite: any[] = [];
  for (const entry of parsed.entries) {
    if (entry.type === "label" && mainlineIds.has(entry.targetId)) {
      labelsToWrite.push({ ...entry, id: `${entry.id}-r`, parentId: lastEntryId, timestamp: entry.timestamp ?? new Date().toISOString() });
    }
  }

  const target = resolveTarget(source, { templateId: opts.templateId });
  if (!target.ok) return target.error;
  const written = writeNewSession(target.dir, target.cwd, source.file, [...finalPath, ...labelsToWrite]);
  if (!written.ok) return written.error;
  return {
    ok: true,
    message: `✅ 已从节点 ${opts.at} 建分支 → ${path.basename(written.file)}（${finalPath.length} 事件）${warned}`,
    data: { file: written.file, id: written.id, events: finalPath.length },
  };
}
