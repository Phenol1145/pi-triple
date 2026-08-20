/**
 * container-runtime-lock.test.ts —— R3 lock 解析/校验 + 版本约束 + socket 模板。
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expandContainerRuntimeSocket,
  loadContainerRuntimeLock,
  parseContainerRuntimeLock,
  satisfiesVersionConstraint,
} from "../src/container-runtime/index.js";

const cleanups: Array<() => Promise<void>> = [];

function baseRawLock() {
  return {
    version: 1,
    runtimes: [
      {
        id: "docker",
        allowed: true,
        versionConstraint: ">=20.10.0",
        sockets: ["/var/run/docker.sock"],
        probe: { method: "GET", path: "/_ping", successStatus: [200], timeoutMs: 2000 },
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
    ],
  } as const;
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe("parseContainerRuntimeLock（R3）", () => {
  it("合法 lock 全量解析", () => {
    const lock = parseContainerRuntimeLock(baseRawLock());
    expect(lock.version).toBe(1);
    expect(lock.runtimes).toHaveLength(2);
    expect(lock.runtimes[0]).toMatchObject({ id: "docker", allowed: true, versionConstraint: ">=20.10.0" });
    expect(lock.runtimes[0]!.probe).toMatchObject({ method: "GET", path: "/_ping", successStatus: [200] });
  });

  it.each([
    ["version 不是 1", { ...baseRawLock(), version: 2 }],
    ["runtimes 为空", { ...baseRawLock(), runtimes: [] }],
    ["未知 runtime id", { ...baseRawLock(), runtimes: [{ ...baseRawLock().runtimes[0], id: "containerd" }] }],
    ["重复 runtime id", { ...baseRawLock(), runtimes: [baseRawLock().runtimes[0], baseRawLock().runtimes[0]] }],
    ["allowed 非布尔", { ...baseRawLock(), runtimes: [{ ...baseRawLock().runtimes[0], allowed: "yes" }] }],
    ["非法版本约束", { ...baseRawLock(), runtimes: [{ ...baseRawLock().runtimes[0], versionConstraint: "~27.0.0" }] }],
    ["相对 socket 路径", { ...baseRawLock(), runtimes: [{ ...baseRawLock().runtimes[0], sockets: ["docker.sock"] }] }],
    ["未知 socket 占位符", { ...baseRawLock(), runtimes: [{ ...baseRawLock().runtimes[0], sockets: ["${SECRET}/docker.sock"] }] }],
    ["probe method 非 GET", { ...baseRawLock(), runtimes: [{ ...baseRawLock().runtimes[0], probe: { method: "POST", path: "/_ping", successStatus: [200] } }] }],
    ["successStatus 为空", { ...baseRawLock(), runtimes: [{ ...baseRawLock().runtimes[0], probe: { method: "GET", path: "/_ping", successStatus: [] } }] }],
    ["version field 非法", { ...baseRawLock(), runtimes: [{ ...baseRawLock().runtimes[0], version: { method: "GET", path: "/version", field: "..Version" } }] }],
  ])("%s 必须被拒绝", (_label, raw) => {
    expect(() => parseContainerRuntimeLock(raw)).toThrow(/container-runtime-lock invalid/);
  });

  it("loadContainerRuntimeLock 读盘并解析", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cr-lock-"));
    cleanups.push(async () => {
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
    });
    const file = join(dir, "container-runtime-lock.json");
    await writeFile(file, JSON.stringify(baseRawLock()), "utf8");
    const lock = await loadContainerRuntimeLock(file);
    expect(lock.runtimes.map((entry) => entry.id)).toEqual(["docker", "orbstack"]);
  });
});

describe("satisfiesVersionConstraint", () => {
  it.each([
    ["27.3.1", ">=20.10.0", true],
    ["20.10.0", ">=20.10.0", true],
    ["19.03.13", ">=20.10.0", false],
    ["v27.3.1", ">=27.0.0", true],
    ["27.3.1+dev", "=27.3.1", true],
    ["1.8.0", "*", true],
    ["not-a-version", "*", false],
    ["5.0.0", ">=4.0.0", true],
  ])("%s against %s → %s", (version, constraint, expected) => {
    expect(satisfiesVersionConstraint(version, constraint)).toBe(expected);
  });
});

describe("expandContainerRuntimeSocket", () => {
  it("绝对路径原样返回", () => {
    expect(expandContainerRuntimeSocket("/var/run/docker.sock", {})).toBe("/var/run/docker.sock");
  });

  it("展开 HOME/XDG_RUNTIME_DIR/UID，缺失时返回 null", () => {
    expect(expandContainerRuntimeSocket("${HOME}/.orbstack/run/docker.sock", { HOME: "/Users/t" })).toBe("/Users/t/.orbstack/run/docker.sock");
    expect(expandContainerRuntimeSocket("${XDG_RUNTIME_DIR}/podman/podman.sock", { XDG_RUNTIME_DIR: "/tmp/xdg" })).toBe("/tmp/xdg/podman/podman.sock");
    expect(expandContainerRuntimeSocket("${HOME}/x", {})).toBeNull();
  });
});
