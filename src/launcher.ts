/**
 * Pi-Triple Launcher — 启动配置好的 pi 实例
 *
 * Pi-Triple 不再自建 TUI，而是作为 pi 的多租户会话管理器：
 * - 认证（token → tenant）
 * - 工作目录隔离（per-tenant workspace）
 * - 模型路由（ModelRouter → --provider --model）
 * - 工具 ACL（ToolRegistry → --tools）
 * - 租户级 system prompt 注入
 *
 * 用户获得 pi 完整的 TUI 体验（Markdown、补全、主题、技能、/命令、!bash）。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

/** 确保路径是绝对路径（避免子进程 cwd 不同导致相对路径失效） */
function abs(p: string): string {
  return path.resolve(process.cwd(), p);
}
import { Redis } from "ioredis";
import { detectPlatform } from "./platform/index.js";
import { createLogger } from "./observability/logger.js";
import { EnvCredentialProvider } from "./storage/credential-provider.js";
import { ModelRouter } from "./model-router/router.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { ensureTenantLinks } from "./shared-layer.js";

export interface LaunchOptions {
  /** Tenant ID (from auth token or "local") */
  tenantId: string;
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
}

export async function launchPi(options: LaunchOptions): Promise<number> {
  const logger = createLogger(process.env.LOG_LEVEL ?? "warn", 2);
  const platform = detectPlatform();

  // --- Workspace isolation ---
  const dataDir = abs(process.env.DATA_DIR ?? "./.pi-platform-data");
  const workspaceMgr = new WorkspaceManager(
    platform,
    path.join(dataDir, "workspaces"),
    path.join(dataDir, "platform"),
    path.join(dataDir, "tenants"),
  );
  const project = options.project ?? "default";
  const cwd = await workspaceMgr.ensureWorkspace(options.tenantId, project);

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

  // --- Tenant system prompt ---
  const tenantPromptPath = path.join(dataDir, "tenants", options.tenantId, "PROMPT.md");
  const hasTenantPrompt = fs.existsSync(tenantPromptPath);

  // --- Build pi args ---
  const args: string[] = [];

  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools) args.push("--tools", options.tools);
  if (options.excludeTools) args.push("--exclude-tools", options.excludeTools);

  // Session management
  const sessionDir = path.join(dataDir, "sessions", options.tenantId);
  fs.mkdirSync(sessionDir, { recursive: true });
  args.push("--session-dir", sessionDir);

  if (options.continueSession) args.push("--continue");
  if (options.resumeSession) args.push("--resume", options.resumeSession);

  // Tenant prompt injection
  if (hasTenantPrompt) {
    args.push("--append-system-prompt", tenantPromptPath);
  }

  // Extra passthrough args
  if (options.extraArgs) args.push(...options.extraArgs);

  // --- Launch pi ---
  const piBin = process.env.PI_BIN ?? "pi";

  logger.info({
    event: "launch_pi",
    tenantId: options.tenantId,
    project,
    cwd,
    provider,
    model,
    args,
  });

  console.log(`\x1b[36mPi-Triple\x1b[0m · tenant: ${options.tenantId} · project: ${project}`);
  if (provider && model) {
    console.log(`Model: ${provider}/${model}`);
  }
  console.log(`Workspace: ${cwd}`);
  console.log("");

  // 确保共享层 symlink 完整（首次启动或租户创建后自动链接）
  const sharedDir = abs(path.join(dataDir, "shared"));
  ensureTenantLinks(abs(path.join(dataDir, "pi-config", options.tenantId)), sharedDir);

  const child = spawn(piBin, args, {
    cwd,
    stdio: "inherit",  // 直接使用终端，pi 的 TUI 完整渲染
    env: {
      ...process.env,
      // 隔离 pi 配置目录（per-tenant）
      PI_CODING_AGENT_DIR: abs(path.join(dataDir, "pi-config", options.tenantId)),
    },
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
