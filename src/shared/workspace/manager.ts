import fs from "node:fs/promises";
import path from "node:path";
import type { PlatformAdapter } from "../platform/index.js";

const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export class WorkspaceManager {
  constructor(
    private platform: PlatformAdapter,
    private basePath: string = "/data/workspaces",
    private platformDir: string = "/data/platform",
    private tenantDir: string = "/data/tenants",
  ) {}

  getCwd(tenantId: string, project: string): string {
    this.validateProjectName(project);
    const ws = this.platform.fs.resolve(this.basePath, tenantId, project);
    if (this.platform.fs.isPathTraversal(this.platform.fs.resolve(this.basePath, tenantId), ws)) {
      throw new Error(`Path traversal detected for project "${project}"`);
    }
    return ws;
  }

  async ensureWorkspace(tenantId: string, project: string): Promise<string> {
    const cwd = this.getCwd(tenantId, project);
    await fs.mkdir(cwd, { recursive: true });
    return cwd;
  }

  getPlatformDir(): string {
    return this.platformDir;
  }

  getTenantOverlayPath(tenantId: string): string {
    return this.platform.fs.resolve(this.tenantDir, tenantId);
  }

  async ensureTenantOverlay(tenantId: string): Promise<string> {
    const overlay = this.getTenantOverlayPath(tenantId);
    await fs.mkdir(path.join(overlay, "skills"), { recursive: true });
    await fs.mkdir(path.join(overlay, "tools"), { recursive: true });
    return overlay;
  }

  private validateProjectName(project: string): void {
    if (!project || !PROJECT_NAME_RE.test(project)) {
      throw new Error(`Invalid project name "${project}". Must match ${PROJECT_NAME_RE.source}`);
    }
  }
}
