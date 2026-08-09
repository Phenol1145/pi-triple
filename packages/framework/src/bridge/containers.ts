/**
 * bridge/containers.ts —— ptl hub 容器运维命令族（容器抽象 v0.7）
 *
 * 声明式部署描述（pth.deployment.json）→ 容器后端接口 → 后端实现。
 * 本机运维：deploy/status/logs/upgrade/exec——不再手写 docker compose 命令。
 *
 *   ptl hub deploy [--backend docker] [--rebuild]   # 部署（build + up）
 *   ptl hub status [--service <s>]                  # 服务状态
 *   ptl hub logs <service> [--tail n]               # 日志
 *   ptl hub upgrade                                 # 重建镜像 + 重启
 *   ptl hub exec <service> -- <cmd...>              # 容器内命令
 *
 * 后端选择：--backend docker|podman|k8s（v0.7 仅 docker——其他为扩展点）。
 */

import { resolve } from "node:path";
import { loadDeployment } from "../containers/deployment.js";
import { getBackend, type BackendKind } from "../containers/backend.js";

const DEPLOYMENT_FILE = "pth.deployment.json";

function deploymentPath(cwd: string): string {
  return resolve(cwd, DEPLOYMENT_FILE);
}

function color(s: string, code: number): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}

function stateColor(state: string): string {
  switch (state) {
    case "running": return color("● running", 32);
    case "starting": return color("◐ starting", 33);
    case "unhealthy": return color("⚠ unhealthy", 33);
    case "exited": return color("○ exited", 31);
    default: return color("· absent", 90);
  }
}

export async function cmdHubDeploy(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const backendKind = (flags.backend ?? "docker") as BackendKind;
  const rebuild = flags.rebuild === "true" || flags.rebuild === "1" || Boolean(flags.rebuild);
  const dep = await loadDeployment(deploymentPath(process.cwd()));
  const backend = await getBackend(backendKind);
  if (!(await backend.available())) {
    console.log(color(`  ❌ 容器后端 ${backendKind} 不可用（docker daemon 未启动？）`, 31));
    process.exit(1);
  }
  console.log(color(`  ▶ 部署 ${dep.name}（后端 ${backendKind}${rebuild ? " + rebuild" : ""}）`, 36));
  await backend.up(dep, { rebuild, detached: true });
  const st = await backend.status(dep);
  for (const s of st.services) {
    console.log(`    ${stateColor(s.state)} ${s.name}${s.health ? ` [${s.health}]` : ""}${s.ports ? `  ${s.ports}` : ""}`);
  }
  console.log(color("  ✓ 部署完成（健康检查就绪后可用）", 32));
}

export async function cmdHubStatus(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const backendKind = (flags.backend ?? "docker") as BackendKind;
  const service = flags.service;
  const dep = await loadDeployment(deploymentPath(process.cwd()));
  const backend = await getBackend(backendKind);
  const st = await backend.status(dep, service);
  if (!st.healthy) {
    console.log(color(`  ⚠ 容器后端 ${backendKind} 状态查询异常`, 33));
  }
  const rows = service ? st.services.filter((s) => s.name === service || s.name.includes(service)) : st.services;
  if (rows.length === 0) {
    console.log(color(`  · 无运行服务${service ? `（${service}）` : ""}——ptl hub deploy 拉起`, 90));
    return;
  }
  for (const s of rows) {
    console.log(`    ${stateColor(s.state)} ${s.name}${s.health ? ` [${s.health}]` : ""}${s.ports ? `  ${s.ports}` : ""}`);
  }
}

export async function cmdHubLogs(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const backendKind = (flags.backend ?? "docker") as BackendKind;
  const service = passthrough[0];
  const tail = Number(flags.tail ?? 100);
  if (!service) {
    console.log(color("  ❌ ptl hub logs <service> [--tail n]", 31));
    process.exit(1);
  }
  const dep = await loadDeployment(deploymentPath(process.cwd()));
  const backend = await getBackend(backendKind);
  const out = await backend.logs(dep, service, tail);
  console.log(out || color(`  · ${service} 无日志`, 90));
}

export async function cmdHubUpgrade(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const backendKind = (flags.backend ?? "docker") as BackendKind;
  const dep = await loadDeployment(deploymentPath(process.cwd()));
  const backend = await getBackend(backendKind);
  console.log(color(`  ▶ 升级 ${dep.name}（重建镜像 + 重启）`, 36));
  await backend.up(dep, { rebuild: true, detached: true });
  console.log(color("  ✓ 升级完成", 32));
}

export async function cmdHubExec(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const backendKind = (flags.backend ?? "docker") as BackendKind;
  const service = passthrough[0];
  const cmd = passthrough.slice(1);
  if (!service || cmd.length === 0) {
    console.log(color("  ❌ ptl hub exec <service> -- <cmd...>", 31));
    process.exit(1);
  }
  const dep = await loadDeployment(deploymentPath(process.cwd()));
  const backend = await getBackend(backendKind);
  const r = await backend.exec(dep, service, cmd);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code === 0 ? 0 : 1;
}
