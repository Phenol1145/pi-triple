/**
 * container-runtime/lock.ts —— container-runtime-lock.json 的解析/校验与 socket 展开。
 *
 * R3：lock 是允许运行时、版本约束与 probe 定义的唯一事实源；
 * 自动探测的 socket 只允许来自 lock 白名单，未知占位符/相对路径一律拒绝。
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ContainerRuntimeId } from "./types.js";
import { isVersionConstraint } from "./version-constraint.js";

export const CONTAINER_RUNTIME_LOCK_FILE = "container-runtime-lock.json";
export const DEFAULT_CONTAINER_RUNTIME_LOCK_PATH = resolve("deploy", CONTAINER_RUNTIME_LOCK_FILE);

export const CONTAINER_RUNTIME_IDS: readonly ContainerRuntimeId[] = ["docker", "orbstack", "podman"];

const SOCKET_PLACEHOLDERS = new Set(["HOME", "UID", "XDG_RUNTIME_DIR"]);
const SOCKET_TEMPLATE_RE = /^\$\{([A-Z_]+)\}(\/.*)?$/;
const VERSION_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export interface ContainerRuntimeProbeSpec {
  readonly method: "GET";
  /** 探测路径（如 /_ping）。 */
  readonly path: string;
  /** 视为成功的 HTTP 状态码（如 [200]）。 */
  readonly successStatus: readonly number[];
  readonly timeoutMs?: number;
}

export interface ContainerRuntimeVersionSpec {
  readonly method: "GET";
  /** 版本端点（如 /version）。 */
  readonly path: string;
  /** 版本字段点路径（如 Version / Client.Version）。 */
  readonly field: string;
  readonly timeoutMs?: number;
}

export interface ContainerRuntimeLockEntry {
  readonly id: ContainerRuntimeId;
  readonly allowed: boolean;
  /** 语义化约束：`* | >=x.y.z | >x.y.z | <=x.y.z | <x.y.z | =x.y.z`。 */
  readonly versionConstraint: string;
  /** socket 白名单；允许绝对路径或 `${HOME|UID|XDG_RUNTIME_DIR}` 模板。 */
  readonly sockets: readonly string[];
  readonly probe: ContainerRuntimeProbeSpec;
  readonly version: ContainerRuntimeVersionSpec;
}

export interface ContainerRuntimeLock {
  readonly version: 1;
  readonly runtimes: readonly ContainerRuntimeLockEntry[];
}

export function parseContainerRuntimeLock(raw: unknown): ContainerRuntimeLock {
  const err = (message: string): Error =>
    new Error(`container-runtime-lock invalid: ${message}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw err("root must be an object");
  const root = raw as Record<string, unknown>;
  if (root.version !== 1) throw err(`version must be 1 (got ${String(root.version)})`);
  if (!Array.isArray(root.runtimes) || root.runtimes.length === 0) throw err("runtimes must be a non-empty array");

  const seen = new Set<string>();
  const runtimes = root.runtimes.map((item, index) => {
    const at = `runtimes[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw err(`${at} must be an object`);
    const entry = item as Record<string, unknown>;

    const id = entry.id;
    if (typeof id !== "string" || !CONTAINER_RUNTIME_IDS.includes(id as ContainerRuntimeId)) {
      throw err(`${at}.id must be one of ${CONTAINER_RUNTIME_IDS.join("/")}`);
    }
    if (seen.has(id)) throw err(`${at}.id duplicates ${id}`);
    seen.add(id);

    if (typeof entry.allowed !== "boolean") throw err(`${at}.allowed must be boolean`);
    if (typeof entry.versionConstraint !== "string" || !isVersionConstraint(entry.versionConstraint)) {
      throw err(`${at}.versionConstraint must be "* | >=x.y.z | >x.y.z | <=x.y.z | <x.y.z | =x.y.z"`);
    }
    if (!Array.isArray(entry.sockets) || entry.sockets.length === 0) throw err(`${at}.sockets must be a non-empty array`);
    const sockets = entry.sockets.map((socket, socketIndex) => {
      if (typeof socket !== "string" || socket.length === 0 || !isAllowedSocketTemplate(socket)) {
        throw err(`${at}.sockets[${socketIndex}] must be an absolute path or \${HOME|UID|XDG_RUNTIME_DIR} template`);
      }
      return socket;
    });

    return {
      id: id as ContainerRuntimeId,
      allowed: entry.allowed,
      versionConstraint: entry.versionConstraint,
      sockets,
      probe: parseProbeSpec(entry.probe, `${at}.probe`),
      version: parseVersionSpec(entry.version, `${at}.version`),
    } satisfies ContainerRuntimeLockEntry;
  });

  return { version: 1, runtimes };
}

export async function loadContainerRuntimeLock(
  filePath: string = DEFAULT_CONTAINER_RUNTIME_LOCK_PATH,
): Promise<ContainerRuntimeLock> {
  const text = await readFile(filePath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`container-runtime-lock unparseable: ${filePath}`, { cause });
  }
  return parseContainerRuntimeLock(raw);
}

function parseProbeSpec(raw: unknown, at: string): ContainerRuntimeProbeSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`container-runtime-lock invalid: ${at} must be an object`);
  const spec = raw as Record<string, unknown>;
  if (spec.method !== "GET") throw new Error(`container-runtime-lock invalid: ${at}.method must be "GET"`);
  if (typeof spec.path !== "string" || !spec.path.startsWith("/")) throw new Error(`container-runtime-lock invalid: ${at}.path must start with "/"`);
  if (!Array.isArray(spec.successStatus) || spec.successStatus.length === 0
    || !spec.successStatus.every((status) => Number.isInteger(status) && status >= 100 && status <= 599)) {
    throw new Error(`container-runtime-lock invalid: ${at}.successStatus must be a non-empty array of 100..599`);
  }
  return {
    method: "GET",
    path: spec.path,
    successStatus: [...spec.successStatus],
    ...(spec.timeoutMs !== undefined ? { timeoutMs: parseTimeout(spec.timeoutMs, `${at}.timeoutMs`) } : {}),
  };
}

function parseVersionSpec(raw: unknown, at: string): ContainerRuntimeVersionSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`container-runtime-lock invalid: ${at} must be an object`);
  const spec = raw as Record<string, unknown>;
  if (spec.method !== "GET") throw new Error(`container-runtime-lock invalid: ${at}.method must be "GET"`);
  if (typeof spec.path !== "string" || !spec.path.startsWith("/")) throw new Error(`container-runtime-lock invalid: ${at}.path must start with "/"`);
  if (typeof spec.field !== "string" || !VERSION_FIELD_RE.test(spec.field)) throw new Error(`container-runtime-lock invalid: ${at}.field must be a dot path of identifiers`);
  return {
    method: "GET",
    path: spec.path,
    field: spec.field,
    ...(spec.timeoutMs !== undefined ? { timeoutMs: parseTimeout(spec.timeoutMs, `${at}.timeoutMs`) } : {}),
  };
}

function parseTimeout(value: unknown, at: string): number {
  if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 60_000) {
    throw new Error(`container-runtime-lock invalid: ${at} must be an integer in 100..60000`);
  }
  return value as number;
}

function isAllowedSocketTemplate(socket: string): boolean {
  if (socket.startsWith("/")) return !socket.includes("\0");
  const match = SOCKET_TEMPLATE_RE.exec(socket);
  if (!match) return false;
  return SOCKET_PLACEHOLDERS.has(match[1]!);
}

/**
 * 把 lock 中的 socket 模板展开为绝对路径。
 * 环境变量缺失（如未设置 XDG_RUNTIME_DIR 且拿不到 uid）返回 null → 该候选自动跳过。
 */
export function expandContainerRuntimeSocket(
  template: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (template.startsWith("/")) return template;
  const match = SOCKET_TEMPLATE_RE.exec(template);
  if (!match) return null;
  const name = match[1]!;
  const rest = match[2] ?? "";
  if (name === "HOME") {
    const home = env.HOME;
    return home ? `${home}${rest}` : null;
  }
  const uid = env.UID ?? (typeof process.getuid === "function" ? String(process.getuid()) : undefined);
  if (!uid) return null;
  if (name === "UID") return `/run/user/${uid}${rest}`;
  if (name === "XDG_RUNTIME_DIR") {
    const xdg = env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
    return `${xdg}${rest}`;
  }
  return null;
}
