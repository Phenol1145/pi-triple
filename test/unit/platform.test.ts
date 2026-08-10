import { describe, it, expect } from "vitest";
import { detectPlatform } from "@away_from/infra";

describe("PlatformAdapter", () => {
  const adapter = detectPlatform();

  it("detects current OS", () => {
    expect(["linux", "darwin", "win32"]).toContain(adapter.os);
  });

  it("returns a shell path", () => {
    const shell = adapter.shell.getShellPath();
    expect(shell.length).toBeGreaterThan(0);
  });

  it("detects path traversal", () => {
    expect(adapter.fs.isPathTraversal("/data/ws/t1", "/data/ws/t1/proj/file.ts")).toBe(false);
    expect(adapter.fs.isPathTraversal("/data/ws/t1", "/data/ws/t2/secret.ts")).toBe(true);
    expect(adapter.fs.isPathTraversal("/data/ws/t1", "/etc/passwd")).toBe(true);
  });

  it("resolves paths", () => {
    const resolved = adapter.fs.resolve("/data", "ws", "t1");
    expect(resolved).toContain("data");
    expect(resolved).toContain("t1");
  });

  it("normalizes env var keys", () => {
    const key = adapter.env.normalize("PATH");
    expect(typeof key).toBe("string");
  });

  it("returns path separator", () => {
    expect([":", ";"]).toContain(adapter.env.pathSeparator);
  });

  it("returns path policy", () => {
    expect(typeof adapter.fs.pathPolicy.caseSensitive).toBe("boolean");
    expect(adapter.fs.pathPolicy.maxLength).toBeGreaterThan(0);
  });

  it("executes a simple shell command", async () => {
    const result = await adapter.shell.execute("echo hello", { cwd: "/tmp" });
    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
  });

  it("escapeArg produces safe arguments", () => {
    const arg = adapter.shell.escapeArg("it's a test");
    expect(arg.length).toBeGreaterThan(0);
  });
});
