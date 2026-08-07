/**
 * ptl/agent — ptl agent run/clean 命令
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildPiLaunch } from "../launcher.js";
import { startPtlSession } from "@pi-triple/shared";
import { loadConfig, getTemplateAlias, resolveDataDir } from "@pi-triple/shared";
import { configureTmuxServer, tmuxSessionName } from "@pi-triple/shared";
import { WorkspaceManager } from "../../../../src/shared/workspace/manager.js";
import { detectPlatform } from "../../../../src/shared/platform/index.js";
import fs from "node:fs";

/** ptl agent run <template> <task> [--workspace temp|main] */
export async function cmdAgentRun(flags: Record<string, string>, passthrough: string[]): Promise<void> {
  const templateInput = passthrough[0];
  if (!templateInput) {
    console.log("  用法: ptl agent run <template> <task> [--workspace temp|main]");
    process.exit(1);
  }
  const task = passthrough.slice(1).join(" ").trim();
  if (!task) {
    console.log("  \x1b[31m❌ 请提供 task（要执行的任务描述）\x1b[0m");
    console.log("  用法: ptl agent run <template> <task>");
    process.exit(1);
  }

  const config = loadConfig();
  const templateId = resolveTemplateId(templateInput, config);
  if (!templateId) {
    console.log(`  \x1b[31m❌ 模板 "${templateInput}" 不存在\x1b[0m`);
    process.exit(1);
  }
  const alias = getTemplateAlias(templateId, config);
  const templateConfig = config.templates[templateId]!;

  // Agent instance UUID
  const agentId = randomUUID();

  // Workspace: agents/<agentId>/{temp,main}（路径推导走 WorkspaceManager 单点——F/WP2 Task 7）
  const dataDir = resolveDataDir(config);
  const workspaceMgr = new WorkspaceManager(
    detectPlatform(),
    path.join(dataDir, "workspaces"),
    path.join(dataDir, "platform"),
    path.join(dataDir, "tenants"),
  );
  const agentDir = workspaceMgr.getCwd("agents", agentId); // <base>/agents/<agentId>
  const cwd = flags.workspace === "main"
    ? path.join(agentDir, "main")
    : path.join(agentDir, "temp");
  mkdirSync(path.join(agentDir, "main"), { recursive: true });
  mkdirSync(path.join(agentDir, "temp"), { recursive: true });

  configureTmuxServer();

  const launch = await buildPiLaunch(templateId, {
    agentInstanceId: agentId,
    workspaceCwd: cwd,
    systemPrompt: templateConfig.systemPrompt,
    provider: templateConfig.provider,
    model: templateConfig.model,
    thinking: templateConfig.thinking,
    tools: templateConfig.tools,
    excludeTools: templateConfig.excludeTools,
  });

  const name = `agent-${agentId.slice(0, 8)}`;
  const result = startPtlSession(launch, name, true); // detach=true (background)
  if (result.status !== 0) {
    console.log(`  \x1b[31m❌ 会话启动失败: ${result.stderr}\x1b[0m`);
    process.exit(1);
  }

  // 初始 task 注入：等会话就绪后发送
  const session = tmuxSessionName(name);
  spawnSync("sleep", ["2"], { encoding: "utf-8" });
  spawnSync("tmux", ["send-keys", "-t", session, task, "Enter"], { encoding: "utf-8" });

  console.log(`  Agent: ${agentId}`);
  console.log(`  会话: ${name}`);
  console.log(`  工作区: ${cwd}  (--workspace temp/main 切换)`);
  console.log(`  模板: ${alias} (${templateId.slice(0, 8)}…)`);
  console.log(`  接入: \x1b[36mpit attach ${name}\x1b[0m`);
}

/** ptl agent clean <agentId> [--all] */
export function cmdAgentClean(flags: Record<string, string>, passthrough: string[]): void {
  const config = loadConfig();
  const dataDir = resolveDataDir(config);
  const workspaceMgr = new WorkspaceManager(
    detectPlatform(),
    path.join(dataDir, "workspaces"),
    path.join(dataDir, "platform"),
    path.join(dataDir, "tenants"),
  );
  const agentsDir = workspaceMgr.getTenantWorkspaceRoot("agents");

  if (flags.all === "true") {
    // Clean all agents' temp
    if (!fs.existsSync(agentsDir)) {
      console.log("  无 agent 工作区");
      return;
    }
    let cleaned = 0;
    for (const agentId of fs.readdirSync(agentsDir)) {
      const tempDir = path.join(agentsDir, agentId, "temp");
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.mkdirSync(tempDir);  // 重建空 temp 目录
        cleaned++;
      }
    }
    console.log(`  ✅ 已清理 ${cleaned} 个 agent 的临时工作区 (main 不动)`);
    return;
  }

  const agentId = passthrough[0];
  if (!agentId) {
    console.log("  用法: ptl agent clean <agentId>  或  ptl agent clean --all");
    process.exit(1);
  }

  const tempDir = path.join(agentsDir, agentId, "temp");
  if (!fs.existsSync(tempDir)) {
    console.log(`  \x1b[33m⚠️  agent "${agentId}" 的 temp 工作区不存在\x1b[0m`);
    return;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir);  // 重建空 temp 目录
  console.log(`  ✅ agent "${agentId.slice(0, 8)}…" temp 工作区已清理 (main 不动)`);
}

// helpers

function resolveTemplateId(input: string, config: ReturnType<typeof loadConfig>): string | undefined {
  // 先按 alias 查
  for (const [id, tc] of Object.entries(config.templates)) {
    if (tc.alias === input) return id;
  }
  // 再按 UUID 前缀查
  for (const id of Object.keys(config.templates)) {
    if (id.startsWith(input)) return id;
  }
  return undefined;
}
