import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { detectPlatform, WorkspaceManager } from "@away_from/infra";

/**
 * F/WP2 Task 7 — 工作区分离：层级固化 workspaces/<tenantId>/<projectId>/ + tenant 间路径隔离 + program-run 命名。
 * 路径推导单点断言：消费方应经 manager 方法取路径，不得自拼。
 */

describe("WorkspaceManager 工作区分离（F/WP2 Task 7）", () => {
  let tmpRoot: string;
  let basePath: string;
  let mgr: WorkspaceManager;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mgr-"));
    basePath = path.join(tmpRoot, "workspaces");
    mgr = new WorkspaceManager(
      detectPlatform(),
      basePath,
      path.join(tmpRoot, "platform"),
      path.join(tmpRoot, "tenants"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("层级固化：workspaces/<tenantId>/<projectId>/", async () => {
    const cwd = await mgr.ensureWorkspace("tenant-a", "proj-1");
    expect(cwd).toBe(path.join(basePath, "tenant-a", "proj-1"));
    expect(fs.existsSync(cwd)).toBe(true);
  });

  it("tenant 间路径隔离：A 的目录不在 B 的租户根下（路径级）", async () => {
    const aRoot = mgr.getTenantWorkspaceRoot("tenant-a");
    const bRoot = mgr.getTenantWorkspaceRoot("tenant-b");
    expect(aRoot).toBe(path.join(basePath, "tenant-a"));
    expect(bRoot).toBe(path.join(basePath, "tenant-b"));

    const aCwd = await mgr.ensureWorkspace("tenant-a", "proj-1");
    const bCwd = await mgr.ensureWorkspace("tenant-b", "proj-2");

    // A 的工作区属于 A 的租户根
    expect(aCwd.startsWith(aRoot)).toBe(true);
    // A 不可见 B：A 的工作区路径不在 B 的根下（反之亦然）
    expect(aCwd.startsWith(bRoot)).toBe(false);
    expect(bCwd.startsWith(aRoot)).toBe(false);
    expect(aCwd).not.toBe(bCwd);
  });

  it("program-run 延续 program-run-<sessionId>，且位于租户根下", async () => {
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(mgr.getProgramRunProject(sid)).toBe(`program-run-${sid}`);
    const runCwd = mgr.getProgramRunCwd("tenant-a", sid);
    expect(runCwd).toBe(path.join(basePath, "tenant-a", `program-run-${sid}`));
    expect(runCwd.startsWith(mgr.getTenantWorkspaceRoot("tenant-a"))).toBe(true);

    const ensured = await mgr.ensureProgramRunWorkspace("tenant-a", sid);
    expect(ensured).toBe(runCwd);
    expect(fs.existsSync(ensured)).toBe(true);
  });

  it("路径穿越拒绝：非法 project / tenant", () => {
    expect(() => mgr.getCwd("tenant-a", "../evil")).toThrow();
    expect(() => mgr.getTenantWorkspaceRoot("../evil")).toThrow(/Path traversal/);
  });

  it("P0-3：租户/项目目录权限 0700（不同 UID 不可读）", async () => {
    const cwd = await mgr.ensureWorkspace("tenant-a", "proj-1");
    const tenantRoot = mgr.getTenantWorkspaceRoot("tenant-a");
    expect(fs.statSync(tenantRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(cwd).mode & 0o777).toBe(0o700);
  });
});
