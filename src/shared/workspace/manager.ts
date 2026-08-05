import fs from "node:fs/promises";
import path from "node:path";
import type { PlatformAdapter } from "../platform/index.js";

const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * 工作区管理器（F/WP2 Task 7 层级固化）。
 *
 * 路径约定（F/WP3 Task 12 统一）：本类 basePath 默认 /data/workspaces（容器内 DATA_DIR=/data
 * 时与 sandbox 侧 exec-api 的 cwd 白名单根 workspacesRoot 完全一致——双容器同挂 workspaces 卷
 * 同路径，转发 cwd 无需映射）。消费方不得自行拼装 workspaces/... 路径，一律经本类 resolve/ensure 方法。
 */
export class WorkspaceManager {
  constructor(
    private platform: PlatformAdapter,
    private basePath: string = "/data/workspaces",
    private platformDir: string = "/data/platform",
    private tenantDir: string = "/data/tenants",
  ) {}

  /**
   * 工作区路径推导单点（F/WP2 Task 7）：层级固化 `workspaces/<tenantId>/<projectId>/`。
   * 消费方不得自行拼装 `workspaces/...` 路径，一律经本类 resolve/ensure 方法。
   */
  getCwd(tenantId: string, project: string): string {
    this.validateProjectName(project);
    const ws = this.platform.fs.resolve(this.basePath, tenantId, project);
    if (this.platform.fs.isPathTraversal(this.platform.fs.resolve(this.basePath, tenantId), ws)) {
      throw new Error(`Path traversal detected for project "${project}"`);
    }
    return ws;
  }

  /** 租户工作区根：`<base>/<tenantId>/`——tenant 间路径级隔离边界。 */
  getTenantWorkspaceRoot(tenantId: string): string {
    const root = this.platform.fs.resolve(this.basePath, tenantId);
    if (this.platform.fs.isPathTraversal(this.basePath, root)) {
      throw new Error(`Path traversal detected for tenant "${tenantId}"`);
    }
    return root;
  }

  /** program-run 项目名（延续现状命名约定：`program-run-<sessionId>`）。 */
  getProgramRunProject(sessionId: string): string {
    return `program-run-${sessionId}`;
  }

  /** program 运行工作区：`<base>/<tenantId>/program-run-<sessionId>/`（路径推导单点）。 */
  getProgramRunCwd(tenantId: string, sessionId: string): string {
    return this.getCwd(tenantId, this.getProgramRunProject(sessionId));
  }

  /** 创建 program-run 工作区并返回其 cwd（随会话 evict/destroy 清理）。 */
  async ensureProgramRunWorkspace(tenantId: string, sessionId: string): Promise<string> {
    return this.ensureWorkspace(tenantId, this.getProgramRunProject(sessionId));
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
