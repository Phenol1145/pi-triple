/**
 * Pi-Triple 核心命令逻辑（纯函数，不 console.log）
 *
 * pit.ts print/json 模式和 TUI 命令栏都调用这些函数。
 * 每个函数返回 CommandResult，由调用方决定渲染方式。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadConfig, resolveDataDir,
  resolveTenantId, getTenantAlias, getDefaultTenantId,
  listTenants, createTenant, removeTenant,
} from "./config.js";
import { runDoctorStructured, type DoctorReport } from "./doctor.js";
import { sharedStatus } from "./shared-layer.js";
import { ERR } from "./output.js";

// ─── Types ───────────────────────────────────────────────────

export interface CommandResult {
  ok: boolean;
  message: string;
  data?: any;
  error?: { code: string; message: string; candidates?: string[] };
  handoff?: { cmd: string; args: string[] };
}

// ─── Helpers ─────────────────────────────────────────────────

function hasTmux(): boolean {
  return spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
}

function tmuxSessionName(name: string): string {
  return `pit-${name}`;
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ${mins % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
}

// ─── Commands ────────────────────────────────────────────────

export async function execTenantLs(): Promise<CommandResult> {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  const tenants = listTenants(config);

  if (tenants.length === 0) {
    return { ok: true, message: "(无租户，运行 pit tenant new 创建)", data: { tenants: [] } };
  }

  const lines: string[] = [];
  const data: any[] = [];

  for (const t of tenants) {
    const mark = t.isDefault ? "*" : " ";
    const model = t.config.model ?? "(默认)";
    const tenantDir = path.join(dataDir, "pi-config", t.id);
    const extCount = fs.existsSync(path.join(tenantDir, "extensions"))
      ? fs.readdirSync(path.join(tenantDir, "extensions")).length : 0;
    const skillCount = fs.existsSync(path.join(tenantDir, "skills"))
      ? fs.readdirSync(path.join(tenantDir, "skills")).length : 0;

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

  return { ok: true, message: lines.join("\n"), data: { tenants: data } };
}

export async function execTenantNew(alias?: string): Promise<CommandResult> {
  if (!alias) {
    return {
      ok: false,
      message: "",
      error: { code: ERR.INTERACTIVE_REQUIRED, message: "请提供租户别名: pit tenant new <alias>" },
    };
  }

  const config = loadConfig();
  const dataDir = resolveDataDir(config);

  try {
    const id = createTenant(alias, {}, config);
    const tenantDir = path.join(dataDir, "pi-config", id);

    const displayAlias = getTenantAlias(id, config);

    // Check shared layer
    let sharedMsg = "";
    const sharedDirPath = path.resolve(process.cwd(), config.sharedDir);
    if (fs.existsSync(sharedDirPath)) {
      const { linkTenantToShared } = await import("./shared-layer.js");
      linkTenantToShared(tenantDir, sharedDirPath);
      sharedMsg = "\n  ✅ 已链接共享层";
    }

    // Auto-migrate if pi config exists
    let migrated = false;
    if (!fs.existsSync(path.join(tenantDir, "settings.json"))) {
      const { migrate } = await import("./migrate.js");
      await migrate({ tenantId: id });
      migrated = true;
    }

    return {
      ok: true,
      message: `  ✅ 租户已创建: ${displayAlias} (${id.slice(0, 8)}…)${sharedMsg}`,
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

export async function execTenantRm(input: string): Promise<CommandResult> {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);

  const result = resolveTenantId(input, config);
  if (!result.ok) {
    if (result.reason === "ambiguous") {
      return {
        ok: false,
        message: "",
        error: { code: ERR.TENANT_AMBIGUOUS, message: `"${input}" 匹配多个租户`, candidates: result.candidates },
      };
    }
    return { ok: false, message: "", error: { code: ERR.TENANT_NOT_FOUND, message: `租户 "${input}" 不存在` } };
  }

  const id = result.id;
  const alias = getTenantAlias(id, config);

  // Check running tmux sessions
  const check = spawnSync("tmux", ["has-session", "-t", `pit-${alias}`], { encoding: "utf-8" });
  if (check.status === 0) {
    return {
      ok: false,
      message: "",
      error: { code: ERR.HANDOFF_REQUIRED, message: `租户 "${alias}" 有运行中的会话，先执行: pit stop ${alias}` },
    };
  }

  // Cascade delete
  const dirs = ["pi-config", "sessions", "workspaces", "mailbox"]
    .map((sub) => path.join(dataDir, sub, id))
    .filter((d) => fs.existsSync(d));

  const deleted: string[] = [];
  for (const d of dirs) {
    fs.rmSync(d, { recursive: true, force: true });
    deleted.push(path.relative(process.cwd(), d));
  }
  removeTenant(id, config);

  return {
    ok: true,
    message: `  ✅ 租户 "${alias}" 已删除\n${deleted.map((d) => `  📁 ${d}`).join("\n")}`,
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
  if (!hasTmux()) {
    return { ok: true, message: "  tmux 未安装", data: { sessions: [] } };
  }

  const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}:#{session_windows}:#{session_created}"], { encoding: "utf-8" });
  const sessions = (result.stdout ?? "").trim().split("\n")
    .filter((l) => l.startsWith("pit-"))
    .map((l) => {
      const [full, win, created] = l.split(":");
      return { name: full.replace(/^pit-/, ""), windows: parseInt(win ?? "1"), created: new Date(parseInt(created ?? "0") * 1000) };
    });

  if (sessions.length === 0) {
    return { ok: true, message: "  无后台会话\n  启动: pit start --bg --name coding", data: { sessions: [] } };
  }

  const lines: string[] = ["  \x1b[2mNAME              WINDOWS  CREATED\x1b[0m"];
  const data: any[] = [];
  for (const s of sessions) {
    const age = formatAge(Date.now() - s.created.getTime());
    lines.push(`  \x1b[1m${s.name.padEnd(18)}\x1b[0m${String(s.windows).padEnd(9)}${age}`);
    data.push({ name: s.name, windows: s.windows, createdAt: Math.floor(s.created.getTime() / 1000), createdAgo: age });
  }
  lines.push("\n  接入: \x1b[36mpit attach <name>\x1b[0m · 停止: \x1b[36mpit stop <name>\x1b[0m");

  return { ok: true, message: lines.join("\n"), data: { sessions: data } };
}

export async function execStop(name: string): Promise<CommandResult> {
  if (!name) {
    return { ok: false, message: "", error: { code: ERR.INTERACTIVE_REQUIRED, message: "用法: pit stop <name>" } };
  }
  if (!hasTmux()) {
    return { ok: false, message: "", error: { code: ERR.TMUX_NOT_INSTALLED, message: "tmux 未安装" } };
  }

  if (name === "--all") {
    const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf-8" });
    const pits = (result.stdout ?? "").trim().split("\n").filter((s) => s.startsWith("pit-"));
    if (pits.length === 0) {
      return { ok: true, message: "  无后台会话", data: { stopped: [] } };
    }
    const stopped: string[] = [];
    for (const s of pits) {
      spawnSync("tmux", ["kill-session", "-t", s]);
      stopped.push(s.replace(/^pit-/, ""));
    }
    return {
      ok: true,
      message: stopped.map((s) => `  ✅ 已停止 ${s}`).join("\n"),
      data: { stopped },
    };
  }

  const session = tmuxSessionName(name);
  const result = spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf-8" });
  if (result.status === 0) {
    return { ok: true, message: `  ✅ 已停止 "${name}"`, data: { stopped: [name] } };
  }
  return { ok: false, message: "", error: { code: ERR.SESSION_NOT_FOUND, message: `会话 "${name}" 不存在` } };
}

export async function execStartBg(name: string, tenantInput?: string): Promise<CommandResult> {
  if (!hasTmux()) {
    return { ok: false, message: "", error: { code: ERR.TMUX_NOT_INSTALLED, message: "tmux 未安装" } };
  }

  const config = loadConfig();
  const tenantId = tenantInput
    ? (resolveTenantId(tenantInput, config).ok ? (resolveTenantId(tenantInput, config) as { ok: true; id: string }).id : "")
    : getDefaultTenantId(config);

  if (tenantInput && !resolveTenantId(tenantInput, config).ok) {
    const r = resolveTenantId(tenantInput, config);
    if (!r.ok) {
      return {
        ok: false,
        message: "",
        error: { code: r.reason === "ambiguous" ? ERR.TENANT_AMBIGUOUS : ERR.TENANT_NOT_FOUND, message: `租户 "${tenantInput}" 不存在` },
      };
    }
  }

  const alias = getTenantAlias(tenantId, config);
  const sessionName = name || `${alias}-${Date.now().toString(36)}`;
  const session = tmuxSessionName(sessionName);

  const check = spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf-8" });
  if (check.status === 0) {
    return {
      ok: false,
      message: "",
      error: { code: ERR.HANDOFF_REQUIRED, message: `会话 "${sessionName}" 已在运行。接入: pit attach ${sessionName}` },
    };
  }

  const { buildPiLaunch } = await import("./launcher.js");
  const launch = await buildPiLaunch(tenantId, {
    provider: config.tenants[tenantId]?.provider,
    model: config.tenants[tenantId]?.model,
    continueSession: false,
    extraArgs: [],
  });

  const tmuxArgs = [
    "new-session", "-d", "-s", session,
    "-c", launch.cwd,
    "-x", "200", "-y", "50",
  ];
  for (const [k, v] of Object.entries(launch.env)) {
    if (k === "PI_CODING_AGENT_DIR" || k === "DATA_DIR" || k === "PI_TENANT") {
      tmuxArgs.push("-e", `${k}=${v}`);
    }
  }
  tmuxArgs.push("--", launch.cmd, ...launch.args);

  const result = spawnSync("tmux", tmuxArgs, { encoding: "utf-8" });
  if (result.status === 0) {
    return {
      ok: true,
      message: `  \x1b[32m✅ 后台会话已启动\x1b[0m\n  名称: ${sessionName} · 租户: ${alias} (${tenantId.slice(0, 8)}…)\n  接入: \x1b[36mpit attach ${sessionName}\x1b[0m`,
      data: { name: sessionName, tenantId: tenantId.slice(0, 8), alias },
    };
  }
  return { ok: false, message: "", error: { code: ERR.HANDOFF_REQUIRED, message: `启动失败: ${result.stderr}` } };
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
