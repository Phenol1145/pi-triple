/**
 * container-runtime-socket-probe.test.ts —— Docker-compatible unix socket 只读探测。
 */

import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchContainerRuntimeVersion,
  probeContainerRuntimeSocket,
  socketHttpGet,
} from "../src/container-runtime/index.js";

const dirs: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

async function makeSocketDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cr-socket-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startServer(
  handler: (reqPath: string) => { status: number; body?: string } | null | Promise<{ status: number; body?: string } | null>,
): Promise<string> {
  const dir = await makeSocketDir();
  const socket = join(dir, "runtime.sock");
  const server = createServer(async (req, res) => {
    const result = await handler(req.url ?? "/");
    if (!result) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("nope");
      return;
    }
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(result.body ?? "{}");
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  return socket;
}

describe("socket probe（R2 缺省实现）", () => {
  it("GET /_ping 200 → available；其他状态 → 结构化不可用", async () => {
    const okSocket = await startServer((path) => path === "/_ping" ? { status: 200, body: "OK" } : null);
    await expect(probeContainerRuntimeSocket({ method: "GET", path: "/_ping", successStatus: [200] }, okSocket))
      .resolves.toEqual({ available: true });

    const badSocket = await startServer(() => ({ status: 503, body: "down" }));
    await expect(probeContainerRuntimeSocket({ method: "GET", path: "/_ping", successStatus: [200] }, badSocket))
      .resolves.toMatchObject({ available: false, reason: expect.stringContaining("503") });
  });

  it("socket 不存在 → ENOENT reason", async () => {
    const result = await probeContainerRuntimeSocket(
      { method: "GET", path: "/_ping", successStatus: [200], timeoutMs: 500 },
      join(await makeSocketDir(), "missing.sock"),
    );
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/ENOENT|ECONNREFUSED/);
  });

  it("GET /version 按 field 点路径解析（含 Client.Version）", async () => {
    const socket = await startServer((path) => path === "/version"
      ? { status: 200, body: JSON.stringify({ Client: { Version: "27.3.1" }, ApiVersion: "1.47" }) }
      : null);
    await expect(fetchContainerRuntimeVersion(
      { method: "GET", path: "/version", field: "Client.Version", timeoutMs: 2000 },
      socket,
      "docker",
    )).resolves.toEqual({ id: "docker", version: "27.3.1" });
  });

  it("版本字段缺失 → 抛错；超时 → 抛错", async () => {
    const missingField = await startServer((path) => path === "/version" ? { status: 200, body: "{}" } : null);
    await expect(fetchContainerRuntimeVersion(
      { method: "GET", path: "/version", field: "Version", timeoutMs: 2000 },
      missingField,
      "docker",
    )).rejects.toThrow(/missing or not a string/);

    const hanging = await startServer(() => new Promise<never>(() => {}));
    await expect(socketHttpGet({ socketPath: hanging, path: "/version", timeoutMs: 100 }))
      .rejects.toThrow(/timed out/);
  });
});
