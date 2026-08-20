/**
 * container-runtime/socket-probe.ts —— Docker-compatible unix socket 只读探测。
 *
 * 用于 R2 自动 probe 与版本读取：docker / orbstack / podman 的 socket
 * 都实现 Docker Engine 兼容 API（GET /_ping、GET /version），因此同一实现覆盖三者。
 * 只允许 lock 白名单内路径；任何失败都折叠成结构化 reason，不向上抛原始 body。
 */

import { request, type IncomingHttpHeaders } from "node:http";
import type {
  ContainerRuntimeId,
  ContainerRuntimeProbe,
  ContainerRuntimeVersion,
  ContainerRuntimeCandidate,
} from "./types.js";
import type {
  ContainerRuntimeLockEntry,
  ContainerRuntimeProbeSpec,
  ContainerRuntimeVersionSpec,
} from "./lock.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface SocketHttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export function socketHttpGet(options: {
  readonly socketPath: string;
  readonly path: string;
  readonly method?: "GET";
  readonly timeoutMs?: number;
}): Promise<SocketHttpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: options.socketPath,
        path: options.path,
        method: options.method ?? "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        res.on("data", (chunk: Buffer) => {
          if (aborted) return;
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            aborted = true;
            req.destroy(new Error("response body too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted) return;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`socket request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

export async function probeContainerRuntimeSocket(
  spec: ContainerRuntimeProbeSpec,
  socket: string,
): Promise<ContainerRuntimeProbe> {
  try {
    const result = await socketHttpGet({
      socketPath: socket,
      path: spec.path,
      method: spec.method,
      timeoutMs: spec.timeoutMs,
    });
    if (!spec.successStatus.includes(result.status)) {
      return { available: false, reason: `probe ${spec.path} returned status ${result.status}` };
    }
    return { available: true };
  } catch (cause) {
    return { available: false, reason: errorMessage(cause) };
  }
}

export async function fetchContainerRuntimeVersion(
  spec: ContainerRuntimeVersionSpec,
  socket: string,
  id: ContainerRuntimeId,
): Promise<ContainerRuntimeVersion> {
  const result = await socketHttpGet({
    socketPath: socket,
    path: spec.path,
    method: spec.method,
    timeoutMs: spec.timeoutMs,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch (cause) {
    throw new Error(`version endpoint ${spec.path} returned non-JSON body`, { cause });
  }
  const version = readField(parsed, spec.field);
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`version field ${spec.field} missing or not a string`);
  }
  return { id, version };
}

export function createSocketContainerRuntimeCandidate(
  entry: ContainerRuntimeLockEntry,
  socket: string,
): ContainerRuntimeCandidate {
  return {
    id: entry.id,
    socket,
    versionConstraint: entry.versionConstraint,
    probe: () => probeContainerRuntimeSocket(entry.probe, socket),
    version: () => fetchContainerRuntimeVersion(entry.version, socket, entry.id),
  };
}

function readField(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
