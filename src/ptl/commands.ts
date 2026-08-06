/**
 * Pi-Triple 核心命令逻辑（纯函数，不 console.log）
 *
 * pit.ts print/json 模式和 TUI 命令栏都调用这些函数。
 * 每个函数返回 CommandResult，由调用方决定渲染方式。
 */

import fs from "node:fs";
import path from "node:path";

import {
  loadConfig, resolveDataDir,
  resolveTemplateId, getTemplateAlias,
  listTemplates, createTemplate, removeTemplate,
} from "./config.js";
import { runDoctorStructured } from "./doctor.js";
import { sharedStatus } from "./shared-layer.js";
import { ERR } from "./output.js";
import {
  hasTmux,
  hasPitSession,
  listPitSessions,
  listPitPanesDetailed,
  sessionsForTenant,
  killPitSession,
  formatAge,
  startPitSession,
  getPanePid,
} from "./tmux.js";
import { loadRegistry, markStarted, markStopped } from "./session-registry.js";
import { classifySession, isPidAlive } from "./session-state.js";
import { scanSessionFiles, newestTapeId } from "./session/pi-scan.js";
import { WorkspaceManager } from "../shared/workspace/manager.js";
import { detectPlatform } from "../shared/platform/index.js";


// ─── Types ───────────────────────────────────────────────────

export interface CommandResult {
  ok: boolean;
  message: string;
  data?: any;
  error?: { code: string; message: string; candidates?: string[] };
  handoff?: { cmd: string; args: string[] };
}

// ─── Commands ────────────────────────────────────────────────

export async function execTemplateLs(): Promise<CommandResult> {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  const templates = listTemplates(config);

  if (templates.length === 0) {
    return { ok: true, message: "(无模板，运行 pit template new 创建)", data: { templates: [] } };
  }

  const lines: string[] = [];
  const data: any[] = [];

  for (const t of templates) {
    const mark = t.isDefault ? "*" : " ";
    const model = t.config.model ?? "(默认)";
    const templateDir = path.join(dataDir, "pi-config", t.id);
    const extCount = fs.existsSync(path.join(templateDir, "extensions"))
      ? fs.readdirSync(path.join(templateDir, "extensions")).length : 0;
    const skillCount = fs.existsSync(path.join(templateDir, "skills"))
      ? fs.readdirSync(path.join(templateDir, "skills")).length : 0;

    lines.push(
      `  ${mark} \x1b[1m${t.alias}\x1b[0m  \x1b[2m(${t.id.slice(0, 8)}…)\x1b[0m  model: ${model}  ext: ${extCount}  skills: ${skillCount}${t.isDefault ? "  \x1b[2m(default)\x1b[0m" : ""}`
    );
    data.push({
      id: t.id,
      alias: t.alias,
      isDefault: t.isDefault,
      model: t.config.model ?? null,
      extensions: extCount,
      skills: skillCount,
    });
  }

  return { ok: true, message: lines.join("\n"), data: { templates: data } };
}

export async function execTemplateNew(alias?: string): Promise<CommandResult> {
  if (!alias) {
    return {
      ok: false,
      message: "",
      error: { code: ERR.INTERACTIVE_REQUIRED, message: "请提供模板别名: pit template new <alias>" },
    };
  }

  const config = loadConfig();
  const dataDir = resolveDataDir(config);

  try {
    const id = createTemplate(alias, {}, config);
    const templateDir = path.join(dataDir, "pi-config", id);

    const displayAlias = getTemplateAlias(id, config);

    // Check shared layer
    let sharedMsg = "";
    const sharedDirPath = path.resolve(process.cwd(), config.sharedDir);
    if (fs.existsSync(sharedDirPath)) {
      const { linkTemplateToShared } = await import("./shared-layer.js");
      linkTemplateToShared(templateDir, sharedDirPath);
      sharedMsg = "\n  ✅ 已链接共享层";
    }

    // 写入 AGENTS.md 认知注入（pi 原生机制）
    const { ensureTemplateAgents } = await import("./template-agents.js");
    const agentsWritten = ensureTemplateAgents(templateDir, id, displayAlias);
    if (agentsWritten) sharedMsg += "\n  ✅ 已写入 AGENTS.md（PTL 认知注入）";

    // Auto-migrate if pi config exists
    let migrated = false;
    if (!fs.existsSync(path.join(templateDir, "settings.json"))) {
      const { migrate } = await import("./migrate.js");
      await migrate({ templateId: id });
      migrated = true;
    }

    return {
      ok: true,
      message: `  ✅ 模板已创建: ${displayAlias} (${id.slice(0, 8)}…)${sharedMsg}`,
      data: {
        id,
        alias: displayAlias,
        migrated,
        sharedLinked: sharedMsg !== "",
      },
    };
  } catch (err: any) {
    if (err.message?.startsWith("别名")) {
      return { ok: false, message: "", error: { code: ERR.INTERACTIVE_REQUIRED, message: err.message } };
    }
    throw err;
  }
}

export async function execTemplateRm(input: string): Promise<CommandResult> {
  if (!input) {
    return { ok: false, message: "", error: { code: ERR.INTERACTIVE_REQUIRED, message: "用法: pit template rm <alias|uuid>" } };
  }

  const config = loadConfig();
  const dataDir = resolveDataDir(config);

  const result = resolveTemplateId(input, config);
  if (!result.ok) {
    if (result.reason === "ambiguous") {
      return {
        ok: false,
        message: "",
        error: { code: ERR.TENANT_AMBIGUOUS, message: `"${input}" 匹配多个模板`, candidates: result.candidates },
      };
    }
    return { ok: false, message: "", error: { code: ERR.TENANT_NOT_FOUND, message: `模板 "${input}" 不存在` } };
  }

  const id = result.id;
  const alias = getTemplateAlias(id, config);

  // Check running tmux sessions (B3 fix: prefix match, not exact alias match)
  const running = sessionsForTenant(alias);
  if (running.length > 0) {
    return {
      ok: false,
      message: "",
      error: { code: ERR.HANDOFF_REQUIRED, message: `模板 "${alias}" 有 ${running.length} 个运行中的会话 (${running.map((s) => s.replace(/^pit-/, "")).join(", ")})，先执行: pit stop --all 或逐个停止` },
    };
  }

  // Cascade delete（workspaces 路径推导走 WorkspaceManager 单点——F/WP2 Task 7）
  const workspaceMgr = new WorkspaceManager(
    detectPlatform(),
    path.join(dataDir, "workspaces"),
    path.join(dataDir, "platform"),
    path.join(dataDir, "tenants"),
  );
  const dirs = ["pi-config", "sessions", "mailbox"]
    .map((sub) => path.join(dataDir, sub, id))
    .concat([workspaceMgr.getTenantWorkspaceRoot(id)])
    .filter((d) => fs.existsSync(d));

  const deleted: string[] = [];
  for (const d of dirs) {
    fs.rmSync(d, { recursive: true, force: true });
    deleted.push(path.relative(process.cwd(), d));
  }
  removeTemplate(id, config);

  return {
    ok: true,
    message: `  ✅ 模板 "${alias}" 已删除\n${deleted.map((d) => `  📁 ${d}`).join("\n")}`,
    data: { alias, id: id.slice(0, 8), deleted },
  };
}

export async function execStatus(): Promise<CommandResult> {
  const report = await runDoctorStructured("quick");
  const lines: string[] = [];

  for (const c of report.checks) {
    const icon = c.ok ? "✅" : "❌";
    const color = c.ok ? "\x1b[32m" : "\x1b[31m";
    lines.push(`  ${icon} ${color}${c.name}\x1b[0m — ${c.message}`);
  }

  return {
    ok: report.allOk,
    message: lines.join("\n"),
    data: {
      allOk: report.allOk,
      checks: report.checks.map((c) => ({
        name: c.name,
        ok: c.ok,
        message: c.message,
      })),
    },
  };
}

export async function execLs(): Promise<CommandResult> {
  const config = loadConfig();
  const tmuxSessions = listPitSessions();
  const panes = listPitPanesDetailed();
  const registry = loadRegistry(resolveDataDir(config));

  const liveByName = new Map(tmuxSessions.map((s) => [s.name, s]));
  const sessions = new Set([...tmuxSessions.map((s) => s.name), ...Object.keys(registry.sessions)]);

  const rows: { name: string; status: string; template: string; model: string; info: string }[] = [];
  for (const name of sessions) {
    const live = liveByName.get(name);
    const entry = registry.sessions[name];
    const status = classifySession(
      {
        exists: !!live,
        pid: live ? panes.get(`pit-${name}`)?.pid : undefined,
        currentCommand: live ? panes.get(`pit-${name}`)?.currentCommand : undefined,
      },
      entry ?? null,
    );
    if (!status) continue; // absent / indeterminate
    const template = entry?.templateId
      ? (getTemplateAlias(entry.templateId, config) ?? entry.templateId)
      : (name.includes("-") ? name.split("-")[0] : name);
    const age = live ? formatAge(Date.now() - live.created.getTime()) : "—";
    const model = entry?.model ? ` ${entry.model}` : "";
    rows.push({
      name,
      status,
      template,
      model: model.trim() || "(default)",
      info: `${status === "running" ? age : status === "empty" ? "已退出（空壳）" : "待恢复"}`,
    });
  }
  rows.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status.localeCompare(b.status)));

  if (rows.length === 0) {
    return { ok: true, message: "  无后台会话\n  启动: pit start --bg --name coding", data: { sessions: [] } };
  }

  const MARK: Record<string, string> = { running: "●", empty: "○", orphan: "×" };
  const lines = [
    "  \x1b[2m状态  NAME              TEMPLATE   MODEL\x1b[0m",
    ...rows.map((r) => `  ${MARK[r.status]}  ${r.name.padEnd(18)}${r.template.slice(0, 10).padEnd(11)}${r.model.slice(0, 24)}  ${r.info}`),
    "\n  接入: \x1b[36mpit attach <name>\x1b[0m · 停止: \x1b[36mpit stop <name>\x1b[0m · 恢复: \x1b[36mpit restore\x1b[0m",
  ];
  return { ok: true, message: lines.join("\n"), data: { sessions: rows } };
}

export async function execStop(name: string, flags: Record<string, string> = {}): Promise<CommandResult> {
  const dataDir = resolveDataDir(loadConfig());
  if (flags["stale"] === "true") {
    const panes = listPitPanesDetailed();
    const tmuxNames = listPitSessions();
    const stale: string[] = [];
    for (const s of tmuxNames) {
      const pid = panes.get(`pit-${s.name}`)?.pid;
      if (!isPidAlive(pid)) stale.push(s.name);
    }
    for (const n of stale) { killPitSession(n); markStopped(n, dataDir); }
    return { ok: true, message: stale.length === 0 ? "  无空壳会话" : stale.map((s) => `  ✅ 已清理空壳 ${s}`).join("\n"), data: { stale } };
  }
  if (flags["orphans"] === "true") {
    const registry = loadRegistry(dataDir);
    const orphans = Object.values(registry.sessions).filter((e) => !hasPitSession(e.name)).map((e) => e.name);
    for (const n of orphans) markStopped(n, dataDir);
    return { ok: true, message: orphans.length === 0 ? "  无孤儿条目" : orphans.map((n) => `  ✅ 已清理孤儿 ${n}`).join("\n"), data: { orphans } };
  }
  if (!name) {
    return { ok: false, message: "", error: { code: ERR.INTERACTIVE_REQUIRED, message: "用法: pit stop <name> | --stale | --orphans" } };
  }
  if (!hasTmux()) {
    return { ok: false, message: "", error: { code: ERR.TMUX_NOT_INSTALLED, message: "tmux 未安装" } };
  }

  if (name === "--all") {
    const pits = listPitSessions();
    if (pits.length === 0) {
      return { ok: true, message: "  无后台会话", data: { stopped: [] } };
    }
    const stopped: string[] = [];
    for (const s of pits) {
      killPitSession(s.name);
      markStopped(s.name, dataDir);
      stopped.push(s.name);
    }
    return {
      ok: true,
      message: stopped.map((s) => `  ✅ 已停止 ${s}`).join("\n"),
      data: { stopped },
    };
  }

  if (killPitSession(name)) {
    markStopped(name, dataDir);
    return { ok: true, message: `  ✅ 已停止 "${name}"`, data: { stopped: [name] } };
  }
  return { ok: false, message: "", error: { code: ERR.SESSION_NOT_FOUND, message: `会话 "${name}" 不存在` } };
}

/** 启动后台 tmux 会话（供 TUI / CLI 共用） */
export async function execStartBg(
  name: string,
  templateInput: string,
  extraArgs: string[] = [],
): Promise<CommandResult> {
  if (!hasTmux()) {
    return { ok: false, message: "", error: { code: ERR.TMUX_NOT_INSTALLED, message: "tmux 未安装" } };
  }
  const config = loadConfig();
  const resolved = templateInput
    ? resolveTemplateId(templateInput, config)
    : { ok: true as const, id: config.defaultTemplate };
  if (!resolved.ok) {
    return { ok: false, message: "", error: { code: ERR.TENANT_NOT_FOUND, message: `模板 "${templateInput}" 不存在` } };
  }
  const templateId = resolved.id;
  const alias = getTemplateAlias(templateId, config);
  const sessionName = name || `${alias}-${Date.now().toString(36)}`;

  if (hasPitSession(name)) {
    return { ok: false, message: "", error: { code: "SESSION_EXISTS", message: `会话 "${name}" 已在运行。接入: pit attach ${name}` } };
  }

  const templateConfig = config.templates[templateId] ?? {};
  const { buildPiLaunch: bpl } = await import("./launcher.js");
  const launch = await bpl(templateId, {
    provider: templateConfig.provider,
    model: templateConfig.model,
    thinking: templateConfig.thinking,
    tools: templateConfig.tools,
    excludeTools: templateConfig.excludeTools,
    extraArgs,
  });

  const result = startPitSession(launch, sessionName, true);
  if (result.status === 0) {
    const pid = getPanePid(result.session);
    markStarted({
      name: sessionName,
      templateId,
      model: templateConfig.model,
      provider: templateConfig.provider,
      thinking: templateConfig.thinking,
      extraArgs,
      startedAt: Date.now(),
      pid,
      sessionId: newestTapeId(templateId, Date.now() - 5000, scanSessionFiles(config)),
    }, resolveDataDir(config));
    return {
      ok: true,
      message: `✅ 后台会话 "${sessionName}" 已启动\n接入: pit attach ${sessionName}`,
      data: { name: sessionName, templateId, alias },
    };
  }
  return { ok: false, message: "", error: { code: "TMUX_ERROR", message: `启动失败: ${result.stderr}` } };
}

export async function execSharedStatus(): Promise<CommandResult> {
  const config = loadConfig();
  const sharedDir = path.resolve(process.cwd(), config.sharedDir);
  const st = sharedStatus(sharedDir);

  if (!st.exists) {
    return { ok: true, message: "  共享层未初始化。运行: pit shared init", data: { exists: false } };
  }

  return {
    ok: true,
    message: `  共享层: ${sharedDir}\n  扩展: ${st.extensions} · 技能: ${st.skills} · 包: ${st.packages}`,
    data: { exists: true, dir: sharedDir, extensions: st.extensions, skills: st.skills, packages: st.packages },
  };
}
