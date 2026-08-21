/**
 * container-runtime/selection.ts —— R2 运行时选择协议。
 *
 * 优先级：
 *   1. 显式 env：PI_CONTAINER_RUNTIME=docker|orbstack|podman（可选 PI_CONTAINER_RUNTIME_SOCKET）
 *      —— 只允许 lock 白名单内的 socket；探活/版本/约束任一失败即整体失败，不自动回退。
 *   2. 自动 probe：按 lock 顺序探测白名单 socket（_ping + /version + 版本约束）。
 *   3. 多可用 fail-closed：自动路径恰好一个可用才成功，多个候选可用直接报错。
 */

import type {
  ContainerRuntimeCandidate,
  ContainerRuntimeId,
  ContainerRuntimeProbe,
} from "./types.js";
import {
  expandContainerRuntimeSocket,
  type ContainerRuntimeLock,
  type ContainerRuntimeLockEntry,
} from "./lock.js";
import { satisfiesVersionConstraint } from "./version-constraint.js";
import { createSocketContainerRuntimeCandidate } from "./socket-probe.js";

export const CONTAINER_RUNTIME_ENV = "PI_CONTAINER_RUNTIME";
export const CONTAINER_RUNTIME_SOCKET_ENV = "PI_CONTAINER_RUNTIME_SOCKET";

export type ContainerRuntimeSelectionErrorCode =
  | "RUNTIME_NOT_ALLOWED"
  | "SOCKET_NOT_ALLOWED"
  | "NO_SOCKET_CANDIDATES"
  | "EXPLICIT_RUNTIME_UNAVAILABLE"
  | "NO_RUNTIME_AVAILABLE"
  | "AMBIGUOUS_RUNTIME";

export interface ContainerRuntimeProbeRecord {
  readonly id: ContainerRuntimeId;
  readonly socket: string;
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export interface ContainerRuntimeSelection {
  readonly id: ContainerRuntimeId;
  readonly socket: string;
  readonly version: string;
  readonly source: "env" | "probe";
  readonly probed: readonly ContainerRuntimeProbeRecord[];
}

export class ContainerRuntimeSelectionError extends Error {
  readonly code: ContainerRuntimeSelectionErrorCode;
  readonly probed: readonly ContainerRuntimeProbeRecord[];
  constructor(code: ContainerRuntimeSelectionErrorCode, message: string, probed: readonly ContainerRuntimeProbeRecord[] = []) {
    super(message);
    this.name = "ContainerRuntimeSelectionError";
    this.code = code;
    this.probed = probed;
  }
}

export interface SelectContainerRuntimeOptions {
  readonly lock: ContainerRuntimeLock;
  readonly env?: NodeJS.ProcessEnv;
  /** 测试/扩展注入；缺省为 Docker-compatible unix socket 探测实现。 */
  readonly createCandidate?: (entry: ContainerRuntimeLockEntry, socket: string) => ContainerRuntimeCandidate;
}

export interface ContainerRuntimeCandidateBuild {
  readonly candidates: readonly ContainerRuntimeCandidate[];
  readonly skipped: readonly { readonly id: ContainerRuntimeId; readonly socket: string; readonly reason: string }[];
}

export function buildContainerRuntimeCandidates(
  lock: ContainerRuntimeLock,
  env: NodeJS.ProcessEnv = process.env,
  createCandidate: (entry: ContainerRuntimeLockEntry, socket: string) => ContainerRuntimeCandidate
    = createSocketContainerRuntimeCandidate,
): ContainerRuntimeCandidateBuild {
  const candidates: ContainerRuntimeCandidate[] = [];
  const skipped: Array<{ readonly id: ContainerRuntimeId; readonly socket: string; readonly reason: string }> = [];
  for (const entry of lock.runtimes) {
    if (!entry.allowed) continue;
    for (const template of entry.sockets) {
      const socket = expandContainerRuntimeSocket(template, env);
      if (socket === null) {
        skipped.push({ id: entry.id, socket: template, reason: "socket template could not be expanded" });
        continue;
      }
      candidates.push(createCandidate(entry, socket));
    }
  }
  return { candidates, skipped };
}

async function probeCandidate(candidate: ContainerRuntimeCandidate): Promise<ContainerRuntimeProbeRecord> {
  let probe: ContainerRuntimeProbe;
  try {
    probe = await candidate.probe();
  } catch (cause) {
    return { id: candidate.id, socket: candidate.socket, available: false, reason: `probe-error: ${messageOf(cause)}` };
  }
  if (!probe.available) {
    return { id: candidate.id, socket: candidate.socket, available: false, reason: probe.reason ?? "probe reported unavailable" };
  }
  let version: string;
  try {
    const info = await candidate.version();
    if (info.id !== candidate.id) {
      return { id: candidate.id, socket: candidate.socket, available: false, reason: `version identity mismatch: ${info.id}` };
    }
    version = info.version;
  } catch (cause) {
    return { id: candidate.id, socket: candidate.socket, available: false, reason: `version-error: ${messageOf(cause)}` };
  }
  if (!satisfiesVersionConstraint(version, candidate.versionConstraint)) {
    return {
      id: candidate.id,
      socket: candidate.socket,
      available: false,
      version,
      reason: `version ${version} does not satisfy ${candidate.versionConstraint}`,
    };
  }
  return { id: candidate.id, socket: candidate.socket, available: true, version };
}

export async function selectContainerRuntime(options: SelectContainerRuntimeOptions): Promise<ContainerRuntimeSelection> {
  const env = options.env ?? process.env;
  const createCandidate = options.createCandidate ?? createSocketContainerRuntimeCandidate;
  const { candidates } = buildContainerRuntimeCandidates(options.lock, env, createCandidate);

  const explicitIdRaw = env[CONTAINER_RUNTIME_ENV]?.trim();
  if (explicitIdRaw) {
    return selectExplicit(options.lock, candidates, explicitIdRaw, env[CONTAINER_RUNTIME_SOCKET_ENV]?.trim(), env);
  }

  const probed: ContainerRuntimeProbeRecord[] = [];
  for (const candidate of candidates) {
    probed.push(await probeCandidate(candidate));
  }
  const available = probed.filter((record) => record.available);
  if (available.length === 0) {
    throw new ContainerRuntimeSelectionError(
      "NO_RUNTIME_AVAILABLE",
      `no allowed container runtime is available (${probed.map((r) => `${r.id}@${r.socket}: ${r.reason ?? "ok"}`).join("; ") || "no socket candidates"})`,
      probed,
    );
  }
  if (available.length > 1) {
    throw new ContainerRuntimeSelectionError(
      "AMBIGUOUS_RUNTIME",
      `multiple container runtimes are available; set ${CONTAINER_RUNTIME_ENV} explicitly: ${available.map((r) => `${r.id}@${r.socket}`).join(", ")}`,
      probed,
    );
  }
  const picked = available[0]!;
  return {
    id: picked.id,
    socket: picked.socket,
    version: picked.version!,
    source: "probe",
    probed,
  };
}

async function selectExplicit(
  lock: ContainerRuntimeLock,
  candidates: readonly ContainerRuntimeCandidate[],
  explicitId: string,
  explicitSocket: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<ContainerRuntimeSelection> {
  const entry = lock.runtimes.find((item) => item.id === explicitId);
  if (!entry) {
    throw new ContainerRuntimeSelectionError(
      "RUNTIME_NOT_ALLOWED",
      `explicit container runtime "${explicitId}" is not declared in container-runtime-lock.json`,
    );
  }
  if (!entry.allowed) {
    throw new ContainerRuntimeSelectionError(
      "RUNTIME_NOT_ALLOWED",
      `explicit container runtime "${explicitId}" is disallowed in container-runtime-lock.json`,
    );
  }

  const allowedSockets = entry.sockets
    .map((template) => expandContainerRuntimeSocket(template, env))
    .filter((socket): socket is string => socket !== null);
  if (explicitSocket !== undefined) {
    if (!allowedSockets.includes(explicitSocket)) {
      throw new ContainerRuntimeSelectionError(
        "SOCKET_NOT_ALLOWED",
        `socket ${explicitSocket} is not in the lock whitelist for ${explicitId} (allowed: ${allowedSockets.join(", ") || "none"})`,
      );
    }
  }

  const matching = candidates.filter((candidate) =>
    candidate.id === entry.id && (explicitSocket === undefined || candidate.socket === explicitSocket));
  if (matching.length === 0) {
    throw new ContainerRuntimeSelectionError(
      "NO_SOCKET_CANDIDATES",
      `no expandable socket candidate for explicit runtime ${explicitId}`,
    );
  }

  const probed: ContainerRuntimeProbeRecord[] = [];
  for (const candidate of matching) {
    probed.push(await probeCandidate(candidate));
  }
  const available = probed.filter((record) => record.available);
  if (available.length > 1) {
    throw new ContainerRuntimeSelectionError(
      "AMBIGUOUS_RUNTIME",
      `multiple sockets are available for explicit runtime ${explicitId}; set ${CONTAINER_RUNTIME_SOCKET_ENV} to pick one: ${available.map((r) => r.socket).join(", ")}`,
      probed,
    );
  }
  const picked = available[0];
  if (!picked) {
    throw new ContainerRuntimeSelectionError(
      "EXPLICIT_RUNTIME_UNAVAILABLE",
      `explicit container runtime ${explicitId} is unavailable (${probed.map((r) => r.reason ?? "ok").join("; ")})`,
      probed,
    );
  }
  return {
    id: picked.id,
    socket: picked.socket,
    version: picked.version!,
    source: "env",
    probed,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
