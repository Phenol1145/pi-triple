/**
 * containers/deployment.ts —— 声明式部署描述（容器抽象 v0.7）
 *
 * 容器后端接口的输入契约：与 docker-compose 方言解耦的服务拓扑描述。
 * 现有 compose 的全部语义收敛为统一 schema——docker/podman/k8s 后端各自翻译。
 *
 * 设计意图（docs/pth/deployment.md §6）：
 * - env 统一：PTH_* env 全保留（与 compose 插值解耦——后端传 env 即可）
 * - 卷语义明确：workspaces/platform/tenants/components/agent-dir/sessions/artifacts
 * - 健康检查自带：/health + 端口探测（k8s readiness/liveness 直接复用）
 * - 网络契约：sandbox-internal 零出口（k8s NetworkPolicy / podman 等价实现）
 */

import { z } from "zod";

export const ServiceSchema = z.object({
  image: z.string().optional(),
  build: z.string().optional(),
  dockerfile: z.string().optional(),
  ports: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  healthcheck: z.object({
    test: z.array(z.string()),
    interval: z.string().optional(),
    timeout: z.string().optional(),
    retries: z.number().optional(),
    startPeriod: z.string().optional(),
  }).optional(),
  limits: z.object({
    cpus: z.union([z.string(), z.number()]).optional(),
    memory: z.string().optional(),
    pids: z.number().optional(),
  }).optional(),
  internal: z.boolean().optional(),
  dependsOn: z.array(z.string()).optional(),
  command: z.array(z.string()).optional(),
  user: z.string().optional(),
});

export const NetworkSchema = z.object({
  internal: z.boolean().optional(),
  driver: z.string().optional(),
});

export const DeploymentSchema = z.object({
  name: z.string(),
  services: z.record(z.string(), ServiceSchema),
  networks: z.record(z.string(), NetworkSchema).optional(),
});

export type DeploymentService = z.infer<typeof ServiceSchema>;
export type DeploymentNetwork = z.infer<typeof NetworkSchema>;
export type Deployment = z.infer<typeof DeploymentSchema>;

export function parseDeployment(json: unknown): Deployment {
  return DeploymentSchema.parse(json);
}

export async function loadDeployment(path: string): Promise<Deployment> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(path, "utf8");
  return parseDeployment(JSON.parse(raw));
}
