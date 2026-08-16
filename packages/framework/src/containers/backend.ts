/**
 * containers/backend.ts —— 容器后端接口（容器抽象 v0.7）
 *
 * 统一契约：up/down/status/logs/restart/exec——docker compose / podman / k8s
 * 各自实现。调用方（PTL 侧工具 / 运维脚本）只面对部署描述 + 后端 kind。
 */

import type { Deployment } from "./deployment.js";

export type BackendKind = "docker" | "podman" | "k8s";

export interface ServiceStatus {
  name: string;
  state: "running" | "starting" | "exited" | "absent" | "unhealthy";
  health?: "healthy" | "unhealthy" | "starting";
  ports?: string;
  pid?: number;
  uptime?: string;
}

export interface BackendStatus {
  backend: BackendKind;
  healthy: boolean;
  services: ServiceStatus[];
}

export interface ContainerBackend {
  readonly kind: BackendKind;
  up(deployment: Deployment, opts?: { rebuild?: boolean; detached?: boolean }): Promise<void>;
  down(deployment: Deployment): Promise<void>;
  status(deployment: Deployment, service?: string): Promise<BackendStatus>;
  logs(deployment: Deployment, service: string, tail?: number): Promise<string>;
  restart(deployment: Deployment, service?: string): Promise<void>;
  exec(deployment: Deployment, service: string, cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  available(): Promise<boolean>;
}

/** 后端注册表：实现模块 import 时自注册（模块专项 ④ 断 backend↔docker-backend 文件环） */
const registry = new Map<BackendKind, () => Promise<ContainerBackend>>();

export function registerContainerBackend(kind: BackendKind, factory: () => Promise<ContainerBackend>): void {
  registry.set(kind, factory);
}

/** 后端选择：kind → 实现（docker-backend 自注册；podman/k8s 占位——扩展点） */
export async function getBackend(kind: BackendKind): Promise<ContainerBackend> {
  const factory = registry.get(kind);
  if (!factory) {
    throw new Error(`容器后端 "${kind}" 尚未实现（v0.7 仅 docker——podman/k8s 为扩展点）`);
  }
  return factory();
}
