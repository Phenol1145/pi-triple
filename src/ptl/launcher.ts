/**
 * Pi-Triple Launcher — 启动配置好的 pi 实例
 *
 * Pi-Triple 不再自建 TUI，而是作为 pi 的多模板会话管理器：
 * - 认证（token → tenant）
 * - 工作目录隔离（per-tenant workspace）
 * - 模型路由（ModelRouter → --provider --model）
 * - 工具 ACL（ToolRegistry → --tools）
 * - 模板级 system prompt 注入
 *
 * 用户获得 pi 完整的 TUI 体验（Markdown、补全、主题、技能、/命令、!bash）。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

/** 确保路径是绝对路径（避免子进程 cwd 不同导致相对路径失效） */
function abs(p: string): string {
  return path.resolve(process.cwd(), p);
}
import { detectPlatform } from "../shared/platform/index.js";
import { createLogger } from "../shared/observability/logger.js";
import { EnvCredentialProvider } from "../shared/credential-provider.js";
import { ModelRouter } from "../shared/model-router/router.js";
import { WorkspaceManager } from "../shared/workspace/manager.js";
import { ensureTemplateLinks } from "./shared-layer.js";
import { getTemplateAlias, resolveDataDir } from "./config.js";

export interface LaunchOptions {
  /** Tenant ID (from auth token or "local") */
  templateId: string;
  /** Project name (workspace subdirectory) */
  project?: string;
  /** Override provider (skip ModelRouter) */
  provider?: string;
  /** Override model (skip ModelRouter) */
  model?: string;
  /** Thinking level */
  thinking?: string;
  /** Tool allowlist (comma-separated) */
  tools?: string;
  /** Tool denylist (comma-separated) */
  excludeTools?: string;
  /** Continue previous session */
  continueSession?: boolean;
  /** Resume specific session */
  resumeSession?: string;
  /** Extra args passed through to pi */
  extraArgs?: string[];
  /** Agent instance UUID (set PI_AGENT_INSTANCE_ID env) */
  agentInstanceId?: string;
  /** Override cwd for agent workspace */
  workspaceCwd?: string;
  /** Agent system prompt (content → temp file → --append-system-prompt) */
  systemPrompt?: string;
}

export interface PiBuildResult {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * 构建 pi 启动参数（不执行），供 fg/bg 共用。
 * 需要 provider/model 已解析，剩下的工作区/会话目录/共享链接在此处理。
 */
export async function buildPiLaunch(templateId: string, options: {
  project?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  tools?: string;
  excludeTools?: string;
  continueSession?: boolean;
  resumeSession?: string;
  extraArgs?: string[];
  agentInstanceId?: string;
  workspaceCwd?: string;
  systemPrompt?: string;
}): Promise<PiBuildResult> {
  const platform = detectPlatform();
  const dataDir = abs(resolveDataDir());

  // workspace isolation
  const workspaceMgr = new WorkspaceManager(
    platform,
    path.join(dataDir, "workspaces"),
    path.join(dataDir, "platform"),
    path.join(dataDir, "templates"),
  );
  const project = options.project ?? "default";
  const cwd = options.workspaceCwd
    ? (fs.mkdirSync(options.workspaceCwd, { recursive: true }), options.workspaceCwd)
    : await workspaceMgr.ensureWorkspace(templateId, project);

  // build pi args
  const args: string[] = [];

  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools) args.push("--tools", options.tools);
  if (options.excludeTools) args.push("--exclude-tools", options.excludeTools);

  const sessionDir = path.join(dataDir, "sessions", templateId);
  fs.mkdirSync(sessionDir, { recursive: true });
  args.push("--session-dir", sessionDir);

  if (options.continueSession) args.push("--continue");
  if (options.resumeSession) args.push("--session", options.resumeSession);

  // tenant system prompt
  const tenantPromptPath = path.join(dataDir, "templates", templateId, "PROMPT.md");
  if (fs.existsSync(tenantPromptPath)) {
    args.push("--append-system-prompt", tenantPromptPath);
  }

  if (options.systemPrompt) {
    const tmpDir = path.join(os.tmpdir(), "pit-system-prompt");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${randomUUID()}.md`);
    fs.writeFileSync(tmpFile, options.systemPrompt);
    args.push("--append-system-prompt", tmpFile);
  }

  if (options.extraArgs) args.push(...options.extraArgs);

  // ensure shared layer links
  const piConfigDir = abs(path.join(dataDir, "pi-config", templateId));
  const sharedDir = abs(path.join(dataDir, "shared"));
  ensureTemplateLinks(piConfigDir, sharedDir);

  // session + tenant identity
  const sessionId = randomUUID();

  return {
    cmd: process.env.PI_BIN ?? "pi",
    args,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piConfigDir,
      PI_TEMPLATE: templateId,
      PI_TEMPLATE_ALIAS: getTemplateAlias(templateId),
      PI_SESSION_ID: sessionId,
      AGENT_LAB_DB_PATH: path.join(sharedDir, "agent-lab", "agent-lab.db"),
      AGENT_LAB_CONFIG_DIR: path.join(piConfigDir, "agent-lab"),
      ...(options.agentInstanceId ? { PI_AGENT_INSTANCE_ID: options.agentInstanceId } : {}),
    },
    cwd,
  };
}

export async function launchPi(options: LaunchOptions): Promise<number> {
  const logger = createLogger(process.env.LOG_LEVEL ?? "warn", 2);

  // --- Model routing ---
  let provider = options.provider;
  let model = options.model;

  if (!provider || !model) {

    const credentials = new EnvCredentialProvider();
    const modelRouter = new ModelRouter(credentials, logger);
    await modelRouter.initialize();
    const resolved = modelRouter.resolve(provider, model);
    provider = resolved?.provider ?? provider;
    model = resolved?.id ?? model;
  }

  // --- Build launch params ---
  const launch = await buildPiLaunch(options.templateId, {
    project: options.project,
    provider,
    model,
    thinking: options.thinking,
    tools: options.tools,
    excludeTools: options.excludeTools,
    continueSession: options.continueSession,
    resumeSession: options.resumeSession,
    extraArgs: options.extraArgs,
    agentInstanceId: options.agentInstanceId,
    workspaceCwd: options.workspaceCwd,
    systemPrompt: options.systemPrompt,
  });

  const alias = getTemplateAlias(options.templateId);
  console.log(`\x1b[36mPi-Triple\x1b[0m · tenant: ${alias} (${options.templateId.slice(0, 8)}…) · project: ${options.project ?? "default"}`);
  if (provider && model) {
    console.log(`Model: ${provider}/${model}`);
  }
  console.log(`Workspace: ${launch.cwd}`);
  console.log("");

  logger.info({
    event: "launch_pi",
    templateId: options.templateId,
    project: launch.cwd,
    provider,
    model,
    args: launch.args,
  });

  const child = spawn(launch.cmd, launch.args, {
    cwd: launch.cwd,
    stdio: "inherit",
    env: launch.env,
  });

  return new Promise<number>((resolve) => {
    child.on("close", (code) => {
      logger.info({ event: "pi_exited", code });
      resolve(code ?? 0);
    });
    child.on("error", (err) => {
      console.error(`Failed to launch pi: ${err.message}`);
      console.error(`Make sure pi is installed: npm install -g @earendil-works/pi-coding-agent`);
      resolve(1);
    });
  });
}
