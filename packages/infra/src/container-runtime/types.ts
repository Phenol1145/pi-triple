/**
 * container-runtime/types.ts —— 容器运行时适配器协议（v1 核心类型）。
 *
 * R1 交付面：每个适配器必须暴露 id / probe / version / socket / features 五个成员，
 * 以及三个只读数据方法 listContainers / inspectContainer / getContainerStats。
 * 协议全文见 docs/pth/container-runtime-adapter-protocol.md。
 */

/** 本协议识别的容器运行时 id。后续新增（如 containerd）先登记 lock 与协议。 */
export type ContainerRuntimeId = "docker" | "orbstack" | "podman";

export interface ContainerRuntimeProbe {
  readonly available: boolean;
  /** 不可用或探测失败时的稳定原因（不包含凭据/完整 body）。 */
  readonly reason?: string;
}

export interface ContainerRuntimeVersion {
  readonly id: ContainerRuntimeId;
  /** 引擎语义化版本（如 27.3.1）。 */
  readonly version: string;
  /** Docker-compatible API 版本（如 1.47）；非该类 API 可省略。 */
  readonly apiVersion?: string;
}

/**
 * 三个必选只读方法之外的附加能力位。
 * 必选能力（list/inspect/stats）由接口结构保证，不重复声明。
 */
export interface ContainerRuntimeFeatures {
  readonly events?: boolean;
  readonly health?: boolean;
}

export interface ContainerRuntimeSummary {
  readonly id: string;
  readonly names: string[];
  readonly image: string;
  readonly state:
    | "created"
    | "running"
    | "paused"
    | "restarting"
    | "removing"
    | "exited"
    | "dead"
    | "unknown";
  readonly status: string;
  readonly health?: "healthy" | "unhealthy" | "starting" | "none";
}

export interface ContainerRuntimeInspect {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  /** epoch ms；未知/零值为 null。 */
  readonly createdAt: number | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly running: boolean;
  readonly exitCode: number | null;
}

/**
 * 单帧 stats。CPU 字段是累计值（不计算百分比）：
 * 调用方用相邻两帧做 Δtotal/Δsystem×onlineCpus，与现网 docker-monitor 口径一致。
 */
export interface ContainerRuntimeStats {
  readonly id: string;
  readonly cpu: {
    readonly onlineCpus: number;
    readonly totalUsage: number;
    readonly systemUsage: number;
  };
  readonly memory: {
    readonly usageBytes: number;
    readonly limitBytes: number;
  };
  readonly network: {
    readonly rxBytes: number;
    readonly txBytes: number;
  };
}

export interface ContainerRuntimeAdapter {
  readonly id: ContainerRuntimeId;
  readonly socket: string;
  probe(): Promise<ContainerRuntimeProbe>;
  version(): Promise<ContainerRuntimeVersion>;
  readonly features: Readonly<ContainerRuntimeFeatures>;
  listContainers(): Promise<readonly ContainerRuntimeSummary[]>;
  inspectContainer(id: string): Promise<ContainerRuntimeInspect>;
  getContainerStats(id: string): Promise<ContainerRuntimeStats>;
}

/**
 * R2 选择协议的最小探测面：由 lock 条目 + socket 白名单生成。
 * 它只负责探活/取版本，不要求完整数据适配器——R4/R5 再把选中的
 * socket 装配成完整 ContainerRuntimeAdapter。
 */
export interface ContainerRuntimeCandidate {
  readonly id: ContainerRuntimeId;
  readonly socket: string;
  readonly versionConstraint: string;
  probe(): Promise<ContainerRuntimeProbe>;
  version(): Promise<ContainerRuntimeVersion>;
}
