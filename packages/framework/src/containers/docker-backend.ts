/**
 * containers/docker-backend.ts —— docker compose 后端（容器抽象 v0.7）
 *
 * 部署描述 → docker compose 渲染 → docker compose 命令执行。
 * 渲染产物写 <project>/pth.deploy/compose.<name>.generated.yaml（gitignore）——
 * 描述是事实源，compose 文件是后端方言翻译（不双维护）。
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Deployment } from "./deployment.js";
import type { ContainerBackend, BackendStatus, ServiceStatus } from "./backend.js";

export const COMPOSE_GEN_DIR = "pth.deploy";

/** 部署描述 → docker compose yaml（方言翻译——描述是事实源） */
export function renderCompose(dep: Deployment): string {
  const lines: string[] = [];
  lines.push(`# 生成物（容器抽象 v0.7 docker 后端渲染）——勿手改；事实源 = pth.deployment.json`);
  lines.push(`name: ${dep.name}`);
  lines.push("services:");
  for (const [name, svc] of Object.entries(dep.services)) {
    lines.push(`  ${name}:`);
    if (svc.build) {
      lines.push(`    build:`);
      lines.push(`      context: ${svc.build}`);
      if (svc.dockerfile) lines.push(`      dockerfile: ${svc.dockerfile}`);
    }
    if (svc.image && !svc.build) lines.push(`    image: ${svc.image}`);
    if (svc.ports && svc.ports.length > 0) {
      lines.push(`    ports:`);
      for (const p of svc.ports) lines.push(`      - "${p}"`);
    }
    if (svc.env && Object.keys(svc.env).length > 0) {
      lines.push(`    environment:`);
      for (const [k, v] of Object.entries(svc.env)) {
        const val = /^\$/.test(v) ? v : JSON.stringify(v);
        lines.push(`      - ${k}=${val}`);
      }
    }
    if (svc.volumes && svc.volumes.length > 0) {
      lines.push(`    volumes:`);
      for (const v of svc.volumes) lines.push(`      - ${v}`);
    }
    if (svc.healthcheck) {
      lines.push(`    healthcheck:`);
      lines.push(`      test: ${JSON.stringify(svc.healthcheck.test)}`);
      if (svc.healthcheck.interval) lines.push(`      interval: ${svc.healthcheck.interval}`);
      if (svc.healthcheck.timeout) lines.push(`      timeout: ${svc.healthcheck.timeout}`);
      if (svc.healthcheck.retries != null) lines.push(`      retries: ${svc.healthcheck.retries}`);
      if (svc.healthcheck.startPeriod) lines.push(`      start_period: ${svc.healthcheck.startPeriod}`);
    }
    if (svc.limits) {
      lines.push(`    deploy:`);
      lines.push(`      resources:`);
      lines.push(`        limits:`);
      if (svc.limits.cpus != null) lines.push(`          cpus: "${svc.limits.cpus}"`);
      if (svc.limits.memory) lines.push(`          memory: ${svc.limits.memory}`);
      if (svc.limits.pids != null) lines.push(`          pids: ${svc.limits.pids}`);
    }
    if (svc.internal) {
      lines.push(`    networks:`);
      lines.push(`      - ${dep.name}_sandbox-internal`);
    }
    if (svc.dependsOn && svc.dependsOn.length > 0) {
      lines.push(`    depends_on:`);
      for (const d of svc.dependsOn) lines.push(`      - ${d}`);
    }
    if (svc.command) lines.push(`    command: ${JSON.stringify(svc.command)}`);
    if (svc.user) lines.push(`    user: ${svc.user}`);
    if (!svc.internal) {
      lines.push(`    networks:`);
      lines.push(`      - ${dep.name}_default`);
    }
  }
  lines.push("networks:");
  lines.push(`  ${dep.name}_default:`);
  lines.push(`    driver: bridge`);
  lines.push(`  ${dep.name}_sandbox-internal:`);
  lines.push(`    driver: bridge`);
  lines.push(`    internal: true`);
  return lines.join("\n") + "\n";
}

async function projectRoot(start?: string): Promise<string> {
  const { access } = await import("node:fs/promises");
  let dir = resolve(start ?? process.cwd());
  for (;;) {
    try {
      await access(join(dir, "pth.deployment.json"));
      return dir;
    } catch {
      const parent = resolve(dir, "..");
      if (parent === dir) return process.cwd();
      dir = parent;
    }
  }
}

function run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export class DockerBackend implements ContainerBackend {
  readonly kind = "docker" as const;

  async available(): Promise<boolean> {
    return run("docker", ["info"]).code === 0;
  }

  private async composeFile(dep: Deployment): Promise<string> {
    const root = await projectRoot();
    const dir = join(root, COMPOSE_GEN_DIR);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `compose.${dep.name}.generated.yaml`);
    await writeFile(file, renderCompose(dep), "utf8");
    return file;
  }

  private base(dep: Deployment): string[] {
    return ["compose", "--ansi", "never"];
  }

  async up(dep: Deployment, opts?: { rebuild?: boolean; detached?: boolean }): Promise<void> {
    const file = await this.composeFile(dep);
    if (opts?.rebuild) {
      const b = run("docker", [...this.base(dep), "-f", file, "build"]);
      if (b.code !== 0) throw new Error(`docker compose build failed: ${b.stderr}`);
    }
    const args = [...this.base(dep), "-f", file, "--project-name", dep.name, "up", "-d"];
    const r = run("docker", args);
    if (r.code !== 0) throw new Error(`docker compose up failed: ${r.stderr}`);
  }

  async down(dep: Deployment): Promise<void> {
    const file = await this.composeFile(dep);
    const r = run("docker", [...this.base(dep), "-f", file, "--project-name", dep.name, "down"]);
    if (r.code !== 0) throw new Error(`docker compose down failed: ${r.stderr}`);
  }

  async status(dep: Deployment, service?: string): Promise<BackendStatus> {
    const file = await this.composeFile(dep);
    const r = run("docker", [...this.base(dep), "-f", file, "--project-name", dep.name, "ps", "--format", "json"]);
    const services: ServiceStatus[] = [];
    if (r.code === 0 && r.stdout.trim()) {
      for (const line of r.stdout.trim().split("\n")) {
        try {
          const j = JSON.parse(line) as Record<string, string>;
          const name = j.Name ?? j.Service ?? "";
          if (service && name !== service && !name.includes(service)) continue;
          services.push({
            name: name.replace(`${dep.name}-`, ""),
            state: mapState(j.State ?? ""),
            health: mapHealth(j.Health ?? ""),
            ports: j.Ports || undefined,
          });
        } catch { /* 单行解析失败跳过 */ }
      }
    }
    return { backend: this.kind, healthy: r.code === 0, services };
  }

  async logs(dep: Deployment, service: string, tail = 100): Promise<string> {
    const file = await this.composeFile(dep);
    const r = run("docker", [...this.base(dep), "-f", file, "--project-name", dep.name, "logs", "--tail", String(tail), service]);
    if (r.code !== 0) throw new Error(`docker compose logs failed: ${r.stderr}`);
    return (r.stdout + r.stderr).trim();
  }

  async restart(dep: Deployment, service?: string): Promise<void> {
    const file = await this.composeFile(dep);
    const args = [...this.base(dep), "-f", file, "--project-name", dep.name, "restart", ...(service ? [service] : [])];
    const r = run("docker", args);
    if (r.code !== 0) throw new Error(`docker compose restart failed: ${r.stderr}`);
  }

  async exec(dep: Deployment, service: string, cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const file = await this.composeFile(dep);
    return run("docker", [...this.base(dep), "-f", file, "--project-name", dep.name, "exec", "-T", service, ...cmd]);
  }
}

function mapState(s: string): ServiceStatus["state"] {
  if (s === "running") return "running";
  if (s === "exited") return "exited";
  if (s === "created" || s === "restarting") return "starting";
  return "absent";
}
function mapHealth(h: string): ServiceStatus["health"] | undefined {
  if (!h || h === "none") return undefined;
  if (h === "healthy") return "healthy";
  if (h === "unhealthy") return "unhealthy";
  return "starting";
}
