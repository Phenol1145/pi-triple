/**
 * container-runtime-selection.test.ts —— R2 选择协议。
 *
 * 覆盖：显式 env 优先、socket 白名单、版本约束、自动 probe、
 * 多可用 fail-closed、全不可用错误形状。
 */

import { describe, expect, it } from "vitest";
import {
  ContainerRuntimeSelectionError,
  parseContainerRuntimeLock,
  selectContainerRuntime,
  type ContainerRuntimeCandidate,
} from "../src/container-runtime/index.js";

const DOCKER_SOCK = "/var/run/docker.sock";
const ORBSTACK_SOCK = "/Users/test/.orbstack/run/docker.sock";
const PODMAN_SOCK = "/run/user/501/podman/podman.sock";

function baseLock() {
  return parseContainerRuntimeLock({
    version: 1,
    runtimes: [
      {
        id: "docker",
        allowed: true,
        versionConstraint: ">=20.10.0",
        sockets: [DOCKER_SOCK],
        probe: { method: "GET", path: "/_ping", successStatus: [200] },
        version: { method: "GET", path: "/version", field: "Version" },
      },
      {
        id: "orbstack",
        allowed: true,
        versionConstraint: ">=1.0.0",
        sockets: ["${HOME}/.orbstack/run/docker.sock"],
        probe: { method: "GET", path: "/_ping", successStatus: [200] },
        version: { method: "GET", path: "/version", field: "Version" },
      },
      {
        id: "podman",
        allowed: true,
        versionConstraint: ">=4.0.0",
        sockets: ["/run/user/${UID}/podman/podman.sock"],
        probe: { method: "GET", path: "/_ping", successStatus: [200] },
        version: { method: "GET", path: "/version", field: "Version" },
      },
    ],
  });
}

interface FakeOutcome {
  probeOk: boolean;
  version?: string;
  versionId?: string;
  reason?: string;
}

function factoryWith(outcomes: Record<string, FakeOutcome>) {
  return (_entry: { id: "docker" | "orbstack" | "podman"; versionConstraint: string }, socket: string): ContainerRuntimeCandidate => {
    const outcome = outcomes[`${_entry.id}@${socket}`] ?? { probeOk: false, reason: "not wired" };
    return {
      id: _entry.id,
      socket,
      versionConstraint: _entry.versionConstraint,
      probe: async () => outcome.probeOk
        ? { available: true }
        : { available: false, reason: outcome.reason ?? "unavailable" },
      version: async () => ({ id: outcome.versionId ?? _entry.id, version: outcome.version ?? "0.0.0" }),
    };
  };
}

function ok(id: "docker" | "orbstack" | "podman", version: string): FakeOutcome {
  return { probeOk: true, version };
}

const ENV = {
  HOME: "/Users/test",
  UID: "501",
} as NodeJS.ProcessEnv;

describe("selectContainerRuntime（R2）", () => {
  it("显式 PI_CONTAINER_RUNTIME 优先，即使其他 socket 也可用", async () => {
    const outcome = factoryWith({
      [`docker@${DOCKER_SOCK}`]: ok("docker", "27.3.1"),
      [`orbstack@${ORBSTACK_SOCK}`]: ok("orbstack", "1.8.0"),
    });
    const selected = await selectContainerRuntime({
      lock: baseLock(),
      env: { ...ENV, PI_CONTAINER_RUNTIME: "orbstack" },
      createCandidate: outcome,
    });
    expect(selected).toMatchObject({ id: "orbstack", socket: ORBSTACK_SOCK, version: "1.8.0", source: "env" });
  });

  it("显式 socket 必须在 lock 白名单内", async () => {
    const outcome = factoryWith({ [`docker@${DOCKER_SOCK}`]: ok("docker", "27.3.1") });
    await expect(selectContainerRuntime({
      lock: baseLock(),
      env: { ...ENV, PI_CONTAINER_RUNTIME: "docker", PI_CONTAINER_RUNTIME_SOCKET: "/tmp/evil.sock" },
      createCandidate: outcome,
    })).rejects.toMatchObject<Partial<ContainerRuntimeSelectionError>>({
      name: "ContainerRuntimeSelectionError",
      code: "SOCKET_NOT_ALLOWED",
    });
  });

  it("显式 runtime 未在 lock 声明或 allowed=false 都拒绝", async () => {
    const outcome = factoryWith({});
    await expect(selectContainerRuntime({
      lock: baseLock(),
      env: { ...ENV, PI_CONTAINER_RUNTIME: "containerd" },
      createCandidate: outcome,
    })).rejects.toMatchObject({ code: "RUNTIME_NOT_ALLOWED" });

    const disallowed = parseContainerRuntimeLock({
      version: 1,
      runtimes: [{ ...baseLock().runtimes[0]!, allowed: false }],
    });
    await expect(selectContainerRuntime({
      lock: disallowed,
      env: { ...ENV, PI_CONTAINER_RUNTIME: "docker" },
      createCandidate: outcome,
    })).rejects.toMatchObject({ code: "RUNTIME_NOT_ALLOWED" });
  });

  it("显式 runtime 不可用/版本不满足 → 不自动回退", async () => {
    const outcome = factoryWith({
      [`docker@${DOCKER_SOCK}`]: { probeOk: true, version: "19.03.0" },
      [`orbstack@${ORBSTACK_SOCK}`]: ok("orbstack", "1.8.0"),
    });
    await expect(selectContainerRuntime({
      lock: baseLock(),
      env: { ...ENV, PI_CONTAINER_RUNTIME: "docker" },
      createCandidate: outcome,
    })).rejects.toMatchObject({ code: "EXPLICIT_RUNTIME_UNAVAILABLE" });
  });

  it("自动 probe：恰好一个可用 → 成功且 source=probe", async () => {
    const outcome = factoryWith({
      [`docker@${DOCKER_SOCK}`]: ok("docker", "27.3.1"),
      [`podman@${PODMAN_SOCK}`]: { probeOk: false, reason: "ENOENT" },
    });
    const selected = await selectContainerRuntime({
      lock: baseLock(),
      env: ENV,
      createCandidate: outcome,
    });
    expect(selected).toMatchObject({ id: "docker", socket: DOCKER_SOCK, version: "27.3.1", source: "probe" });
  });

  it("自动 probe：多个可用 → fail-closed（AMBIGUOUS_RUNTIME）", async () => {
    const outcome = factoryWith({
      [`docker@${DOCKER_SOCK}`]: ok("docker", "27.3.1"),
      [`orbstack@${ORBSTACK_SOCK}`]: ok("orbstack", "1.8.0"),
    });
    await expect(selectContainerRuntime({
      lock: baseLock(),
      env: ENV,
      createCandidate: outcome,
    })).rejects.toMatchObject({ code: "AMBIGUOUS_RUNTIME" });
  });

  it("自动 probe：全部不可用 → NO_RUNTIME_AVAILABLE 且带逐项 reason", async () => {
    const outcome = factoryWith({
      [`docker@${DOCKER_SOCK}`]: { probeOk: false, reason: "ENOENT" },
    });
    const error = await selectContainerRuntime({
      lock: baseLock(),
      env: ENV,
      createCandidate: outcome,
    }).catch((cause: unknown) => cause) as ContainerRuntimeSelectionError;
    expect(error).toBeInstanceOf(ContainerRuntimeSelectionError);
    expect(error.code).toBe("NO_RUNTIME_AVAILABLE");
    expect(error.probed.some((record) => record.reason?.includes("ENOENT"))).toBe(true);
  });

  it("lock allowed=false 的 runtime 不参与自动 probe", async () => {
    const lock = parseContainerRuntimeLock({
      version: 1,
      runtimes: [
        { ...baseLock().runtimes[0]!, allowed: false },
        { ...baseLock().runtimes[1]! },
      ],
    });
    const outcome = factoryWith({
      [`orbstack@${ORBSTACK_SOCK}`]: ok("orbstack", "1.8.0"),
    });
    const selected = await selectContainerRuntime({ lock, env: ENV, createCandidate: outcome });
    expect(selected.id).toBe("orbstack");
  });
});
