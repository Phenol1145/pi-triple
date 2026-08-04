/**
 * pit/sessions — cmdStart, cmdPi, cmdStartBg, cmdAttach, cmdSwitch, cmdDetach
 */

import { spawnSync } from "node:child_process";
import {
  loadConfig, getTemplateAlias, listTemplates, resolveDataDir,
} from "../config.js";
import { runDoctor } from "../doctor.js";
import { launchPi, buildPiLaunch } from "../launcher.js";
import {
  hasTmux,
  configureTmuxServer,
  tmuxSessionName,
  buildTmuxSessionArgs,
  hasPitSession,
  startPitSession,
  getPanePid,
  validateSessionName,
} from "../tmux.js";
import { loadRegistry, markStarted } from "../session-registry.js";
import { scanSessionFiles, pickRestoreTape, isTapeLive, newestTapeId } from "../session/pi-scan.js";
import { resolveTemplateAndMigrate, resolveOrFail } from "./onboard.js";

/**
 * pit pi — 原生启动模式（前台直接 spawn pi，无 tmux）
 */
export async function cmdPi(flags: Record<string, string>, passthrough: string[]): Promise<void> {
  const r = await resolveTemplateAndMigrate(flags, passthrough);
  if (!r) { process.exit(1); }
  const { templateId, piPassthrough } = r;
  const config = loadConfig();
  const templateConfig = config.templates[templateId] ?? {};

  await runDoctor("quick");

  const code = await launchPi({
    templateId,
    project: flags.project,
    provider: flags.provider ?? templateConfig.provider,
    model: flags.model ?? templateConfig.model,
    thinking: flags.thinking ?? templateConfig.thinking,
    tools: templateConfig.tools,
    excludeTools: templateConfig.excludeTools,
    continueSession: piPassthrough.includes("-c") || piPassthrough.includes("--continue"),
    extraArgs: piPassthrough.filter((a) => a !== "-c" && a !== "--continue"),
  });

  process.exit(code);
}

/**
 * pit start — 默认 tmux 管理模式：创建 tmux 会话并立即接入。
 * --bg 时仅后台创建。
 */
export async function cmdStart(flags: Record<string, string>, passthrough: string[]): Promise<void> {
  const config = loadConfig();

  const hasArgs = flags.template || flags.model || flags.name || flags.bg === "true" || passthrough.length > 0;
  if (!hasArgs && process.stdout.isTTY) {
    const { interactiveStart } = await import("../picker.js");
    const templates = listTemplates(config).map((t) => ({
      id: t.id,
      alias: t.alias,
      isDefault: t.isDefault,
    }));

    const choice = await interactiveStart({ templates });
    flags.template = choice.template;
    if (choice.bg) flags.bg = "true";
    if (choice.name) flags.name = choice.name;
  }

  if (!hasTmux()) {
    console.log("  \x1b[31m❌ tmux 未安装 — pit start 需要 tmux\x1b[0m");
    if (process.platform === "darwin") console.log("  安装: brew install tmux");
    else if (process.platform === "linux") console.log("  安装: sudo apt install tmux");
    console.log("  原生前台启动（无 tmux）: \x1b[36mpit pi\x1b[0m");
    process.exit(1);
  }
  configureTmuxServer();

  if (flags.bg === "true") {
    await cmdStartBg(flags, passthrough);
    return;
  }

  if (!process.stdout.isTTY) {
    console.log("  \x1b[31m❌ pit start（接入模式）需要交互终端\x1b[0m");
    console.log("  纯后台:   pit start --bg --name <name>");
    console.log("  原生前台: pit pi");
    process.exit(1);
  }

  const r = await resolveTemplateAndMigrate(flags, passthrough);
  if (!r) { process.exit(1); }
  const { templateId, piPassthrough } = r;
  const templateConfig = config.templates[templateId] ?? {};
  const alias = getTemplateAlias(templateId, config);
  const name = flags.name ?? `${alias}-${Date.now().toString(36)}`;
  const nameErr = validateSessionName(name);
  if (nameErr) {
    console.log(`  \x1b[31m❌ ${nameErr}\x1b[0m`);
    process.exit(1);
  }
  const session = tmuxSessionName(name);

  const check = spawnSync("tmux", ["has-session", "-t", `=${session}`], { encoding: "utf-8" });
  if (check.status === 0) {
    console.log(`  ⚠️  会话 "${name}" 已存在，直接接入…`);
    spawnSync("tmux", ["attach", "-t", `=${session}`], { stdio: "inherit" });
    return;
  }

  await runDoctor("quick");

  const launch = await buildPiLaunch(templateId, {
    project: flags.project,
    provider: flags.provider ?? templateConfig.provider,
    model: flags.model ?? templateConfig.model,
    thinking: flags.thinking ?? templateConfig.thinking,
    tools: templateConfig.tools,
    excludeTools: templateConfig.excludeTools,
    continueSession: piPassthrough.includes("-c") || piPassthrough.includes("--continue"),
    extraArgs: piPassthrough.filter((a) => a !== "-c" && a !== "--continue"),
  });

  const insideTmux = !!process.env.TMUX;

  if (insideTmux) {
    const create = spawnSync("tmux", buildTmuxSessionArgs(launch, session, true), { encoding: "utf-8" });
    if (create.status !== 0) {
      console.log(`  \x1b[31m❌ 创建会话失败: ${create.stderr}\x1b[0m`);
      process.exit(1);
    }
    const pid = getPanePid(session);
    const now = Date.now();
    markStarted({
      name, templateId,
      model: templateConfig.model, provider: templateConfig.provider, thinking: templateConfig.thinking,
      extraArgs: piPassthrough, startedAt: now, pid,
      sessionId: newestTapeId(templateId, now - 5000, scanSessionFiles(config)),
    }, resolveDataDir(config));
    console.log(`  会话: ${name} · 模板: ${alias} · 切换到新会话…`);
    spawnSync("tmux", ["switch-client", "-t", `=${session}`], { stdio: "inherit" });
    return;
  }

  // 前台非嵌套：先 new-session -d 拿 pid 登记，再 attach 接管（体验与 new-session 直连一致）
  const create = spawnSync("tmux", buildTmuxSessionArgs(launch, session, true), { encoding: "utf-8" });
  if (create.status !== 0) {
    console.log(`  \x1b[31m❌ 创建会话失败: ${create.stderr}\x1b[0m`);
    process.exit(1);
  }
  const pid = getPanePid(session);
  if (!pid) {
    console.log(`  \x1b[31m❌ 会话 "${name}" 启动后立即退出\x1b[0m`);
    console.log("  排查: pit pi --template " + alias + "  （前台模式查看启动错误）");
    process.exit(1);
  }
  const now = Date.now();
  markStarted({
    name, templateId,
    model: templateConfig.model, provider: templateConfig.provider, thinking: templateConfig.thinking,
    extraArgs: piPassthrough, startedAt: now, pid,
    sessionId: newestTapeId(templateId, now - 5000, scanSessionFiles(config)),
  }, resolveDataDir(config));

  console.log(`  会话: ${name} · 模板: ${alias} · Ctrl+B d 脱离（会话保持运行）`);

  const result = spawnSync("tmux", ["attach", "-t", `=${session}`], {
    stdio: "inherit",
    env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
  });
  if (result.status !== 0) {
    console.log(`  \x1b[31m❌ 接入会话失败（pi 可能立即退出，请前台运行排查: pit pi --template ${alias}）\x1b[0m`);
  }
  process.exit(result.status ?? 0);
}

export async function cmdStartBg(flags: Record<string, string>, passthrough: string[]): Promise<void> {
  const config = loadConfig();
  const templateId = resolveOrFail(flags.template, config);
  if (!templateId) { process.exit(1); }
  const alias = getTemplateAlias(templateId, config);
  const name = flags.name ?? `${alias}-${Date.now().toString(36)}`;
  const nameErr = validateSessionName(name);
  if (nameErr) {
    console.log(`  \x1b[31m❌ ${nameErr}\x1b[0m`);
    process.exit(1);
  }

  if (!hasTmux()) {
    console.log("  \x1b[31m❌ tmux 未安装\x1b[0m");
    if (process.platform === "darwin") console.log("  安装: brew install tmux");
    else if (process.platform === "linux") console.log("  安装: sudo apt install tmux");
    else console.log("  Windows: 请使用 WSL2 安装 tmux");
    process.exit(1);
  }
  configureTmuxServer();

  if (hasPitSession(name)) {
    console.log(`  ⚠️  会话 "${name}" 已在运行`);
    console.log(`  接入: pit attach ${name}`);
    return;
  }

  const templateConfig = config.templates[templateId] ?? {};

  const launch = await buildPiLaunch(templateId, {
    project: flags.project,
    provider: flags.provider ?? templateConfig.provider,
    model: flags.model ?? templateConfig.model,
    thinking: flags.thinking ?? templateConfig.thinking,
    tools: templateConfig.tools,
    excludeTools: templateConfig.excludeTools,
    continueSession: passthrough.includes("-c"),
    extraArgs: passthrough.filter((a) => a !== "-c" && a !== "--continue"),
  });

  const result = startPitSession(launch, name, true);

  if (result.status === 0) {
    spawnSync("sleep", ["1"]);
    if (!hasPitSession(name)) {
      console.log(`  \x1b[31m❌ 会话 "${name}" 启动后立即退出\x1b[0m`);
      console.log("  排查: pit pi --template " + alias + "  （前台模式查看启动错误）");
      process.exit(1);
    }
    const pid = getPanePid(result.session);
    const now = Date.now();
    markStarted({
      name, templateId,
      model: templateConfig.model, provider: templateConfig.provider, thinking: templateConfig.thinking,
      extraArgs: passthrough, startedAt: now, pid,
      sessionId: newestTapeId(templateId, now - 5000, scanSessionFiles(config)),
    }, resolveDataDir(config));
    console.log(`  \x1b[32m✅ 后台会话已启动\x1b[0m`);
    console.log(`  名称: ${name} · 模板: ${alias} (${templateId.slice(0, 8)}…) · 工作区: ${launch.cwd}`);
    console.log(`  接入: \x1b[36mpit attach ${name}\x1b[0m`);
    console.log(`  切换: tmux 内 \x1b[2mCtrl+B s\x1b[0m 选择 · \x1b[2mCtrl+B d\x1b[0m 脱离`);
  } else {
    console.log(`  \x1b[31m❌ 启动失败: ${result.stderr}\x1b[0m`);
    process.exit(1);
  }
}

export function cmdAttach(name: string): void {
  if (!name) { console.log("  用法: pit attach <name>"); return; }
  if (!hasTmux()) { console.log("  \x1b[31m❌ tmux 未安装\x1b[0m"); process.exit(1); }

  const session = tmuxSessionName(name);
  const check = spawnSync("tmux", ["has-session", "-t", `=${session}`], { encoding: "utf-8" });
  if (check.status !== 0) {
    console.log(`  \x1b[31m❌ 会话 "${name}" 不存在\x1b[0m`);
    console.log("  运行 pit ls 查看可用会话");
    process.exit(1);
  }

  const result = spawnSync("tmux", ["attach", "-t", `=${session}`], {
    stdio: "inherit",
    env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
  });
  process.exit(result.status ?? 0);
}

export function cmdSwitch(name: string): void {
  if (!name) { console.log("  用法: pit switch <name>"); return; }
  if (!process.env.TMUX) {
    cmdAttach(name);
    return;
  }
  const session = tmuxSessionName(name);
  const check = spawnSync("tmux", ["has-session", "-t", `=${session}`], { encoding: "utf-8" });
  if (check.status !== 0) {
    console.log(`  \x1b[31m❌ 会话 "${name}" 不存在\x1b[0m`);
    process.exit(1);
  }
  spawnSync("tmux", ["switch-client", "-t", `=${session}`], { stdio: "inherit" });
}

export function cmdDetach(): void {
  if (!process.env.TMUX) {
    console.log("  \x1b[33m⚠️  不在 tmux 会话中，无需 detach\x1b[0m");
    return;
  }
  spawnSync("tmux", ["detach-client"], { stdio: "inherit" });
}

// ─── cmdRestore ─────────────────────────────────────────────

/** 恢复目标解析（纯逻辑，可测）：无 name → 全部注册表条目；有 name → 只取指定（缺失静默丢弃） */
export function resolveRestoreTargets(
  names: string[],
  dataDir: string,
): { name: string; entry: import("../session-registry.js").RegistryEntry }[] {
  const reg = loadRegistry(dataDir);
  if (names.length === 0) {
    return Object.entries(reg.sessions).map(([name, entry]) => ({ name, entry }));
  }
  return names
    .filter((n) => reg.sessions[n])
    .map((n) => ({ name: n, entry: reg.sessions[n]! }));
}

/** 按注册表恢复会话：重启后重建 tmux 会话 + resume 原模板最新纸带（--new 则全新） */
export async function cmdRestore(flags: Record<string, string>, passthrough: string[]): Promise<void> {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  const targets = resolveRestoreTargets(passthrough, dataDir);
  if (targets.length === 0) {
    console.log(passthrough.length > 0
      ? `  \x1b[31m❌ 注册表中无指定会话（pit ls 查看 × 状态）\x1b[0m`
      : "  无待恢复会话（注册表为空）");
    return;
  }

  const { buildPiLaunch } = await import("../launcher.js");
  let ok = 0;
  let failed = 0;
  for (const { name, entry } of targets) {
    const session = tmuxSessionName(name);
    const exists = spawnSync("tmux", ["has-session", "-t", `=${session}`], { encoding: "utf-8" }).status === 0;
    if (exists) {
      console.log(`  ⚠️  ${name} 已在运行，跳过`);
      continue;
    }
    try {
      let resumeSession: string | undefined;
      let warning: string | undefined;
      if (flags["new"] !== "true") {
        const files = scanSessionFiles(config);
        const r = pickRestoreTape(files, entry, (id) => isTapeLive(id));
        resumeSession = r.resumeSession;
        warning = r.warning;
      }
      if (warning) console.log(`  ⚠️  ${name}: ${warning}`);
      const launch = await buildPiLaunch(entry.templateId, {
        provider: entry.provider,
        model: entry.model,
        thinking: entry.thinking,
        extraArgs: entry.extraArgs,
        resumeSession,
      });
      const result = startPitSession(launch, name, true);
      if (result.status !== 0) {
        console.log(`  \x1b[31m❌ 恢复 ${name} 失败: ${result.stderr}\x1b[0m`);
        failed++;
        continue;
      }
      const pid = getPanePid(session);
      markStarted({ ...entry, pid, startedAt: Date.now() }, dataDir);
      console.log(`  ✅ 已恢复 ${name}${resumeSession ? `（resume ${resumeSession.slice(0, 8)}…）` : "（全新）"}`);
      ok++;
    } catch (err: any) {
      console.log(`  \x1b[31m❌ 恢复 ${name} 失败: ${err?.message ?? err}\x1b[0m`);
      failed++;
    }
  }
  console.log(`\n  ${failed === 0 ? "\x1b[32m✅" : "\x1b[33m⚠️"} 恢复完成: ${ok} 成功${failed ? `，${failed} 失败` : ""}\x1b[0m`);
  if (ok > 0) console.log("  接入: pit attach <name>");
}
