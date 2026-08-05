/**
 * bridge/client.ts — PTH HTTP 客户端
 *
 * 与 PTH server 通信：submit / list / get / delete / run（SSE 流）。
 * 错误区分：401 token 无效 / 404 PTH 版本过旧 / 其他网络错误。
 */
import { loadConfig, getConfigValue } from "../config.js";
import { type ProgramManifest, type ComponentManifest } from "./manifest.js";

/** SSE 事件 */
export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Submit 响应 */
export interface SubmitResponse {
  name: string;
  version: number;
  bytes: number;
  /** respond 关联闭合信息（评审 WP4-R1 I-2：PTL 需感知闭合结果，不得无条件宣称成功） */
  closedRequest?: string;
  closeWarning?: string;
}

/** Programs 列表条目 */
export interface ProgramEntry {
  name: string;
  latestVersion: number;
  updatedAt: string;
}

/** fallback_requests 条目（F/WP4 Task 20） */
export interface FallbackRequestEntry {
  requestId: string;
  slotHint?: string;
  description: string;
  urgency: string;
  createdAt: string;
  status: "open" | "closed";
  closedBy?: string;
  closedAt?: string;
}

export class PthClient {
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  /** 从 pi-triple.json 读取配置构造客户端 */
  static fromConfig(): PthClient | null {
    const url = process.env.PTH_URL ?? getConfigValue("pth.url");
    const token = process.env.PTH_TOKEN ?? getConfigValue("pth.token");
    if (!url || !token) return null;
    return new PthClient(url, token);
  }

  /** Bearer 认证头 */
  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  /** 统一请求：网络层错误翻译为可操作提示（连接拒绝/DNS/超时等） */
  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.url}${path}`, init);
    } catch (err: any) {
      const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
      throw new Error(
        `无法连接 PTH 服务器 (${this.url}${path})：${reason}。` +
        `请确认 pth 已启动（node dist/pth/main.js），或检查 pit config get pth.url`
      );
    }
  }

  /** 提交程序 */
  async submit(manifest: ProgramManifest, archive: Buffer): Promise<SubmitResponse> {
    const body = JSON.stringify({
      name: manifest.name,
      manifest,
      archive: archive.toString("base64"),
    });

    const res = await this.request("/api/v1/programs", {
      method: "POST",
      headers: this.headers(),
      body,
    });

    if (!res.ok) {
      await this.throwError(res, "提交失败");
    }

    return (await res.json()) as SubmitResponse;
  }

  /** 提交构件（F/WP4 Task 17/20）：components API；requestId 可选（respond 闭合关联） */
  async submitComponent(
    type: ComponentManifest["type"],
    manifest: ComponentManifest,
    archive: Buffer,
    requestId?: string,
  ): Promise<SubmitResponse> {
    const body = JSON.stringify({
      type,
      manifest,
      archive: archive.toString("base64"),
      ...(requestId !== undefined ? { requestId } : {}),
    });

    const res = await this.request("/api/v1/components", {
      method: "POST",
      headers: this.headers(),
      body,
    });

    if (!res.ok) {
      await this.throwError(res, "提交构件失败");
    }

    return (await res.json()) as SubmitResponse;
  }

  /** 手动建单（F/WP4 Task 20） */
  async createFallbackRequest(input: {
    description: string;
    slotHint?: string;
    urgency?: string;
  }): Promise<FallbackRequestEntry> {
    const res = await this.request("/api/v1/fallback-requests", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      await this.throwError(res, "创建回退请求失败");
    }
    return (await res.json()) as FallbackRequestEntry;
  }

  /** 回退请求列表（F/WP4 Task 20——open 优先） */
  async listFallbackRequests(): Promise<FallbackRequestEntry[]> {
    const res = await this.request("/api/v1/fallback-requests", {
      headers: this.headers(),
    });
    if (!res.ok) {
      await this.throwError(res, "获取回退请求列表失败");
    }
    return (await res.json()) as FallbackRequestEntry[];
  }

  /** 列出程序 */
  async list(): Promise<ProgramEntry[]> {
    const res = await this.request("/api/v1/programs", {
      headers: this.headers(),
    });

    if (!res.ok) {
      await this.throwError(res, "获取程序列表失败");
    }

    return (await res.json()) as ProgramEntry[];
  }

  /** 获取程序详情 */
  async get(name: string): Promise<unknown> {
    const res = await this.request(`/api/v1/programs/${encodeURIComponent(name)}`, {
      headers: this.headers(),
    });

    if (!res.ok) {
      await this.throwError(res, "获取程序详情失败");
    }

    return await res.json();
  }

  /** 删除程序 */
  async delete(name: string): Promise<void> {
    const res = await this.request(`/api/v1/programs/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!res.ok) {
      await this.throwError(res, "删除失败");
    }
  }

  /** 运行程序（返回 SSE 事件流） */
  async *run(name: string, input: string | Record<string, string>, version?: number): AsyncIterable<SSEEvent> {
    const body = JSON.stringify({
      input,
      ...(version !== undefined ? { version } : {}),
    });

    const res = await this.request(`/api/v1/programs/${encodeURIComponent(name)}/run`, {
      method: "POST",
      headers: this.headers(),
      body,
    });

    if (!res.ok) {
      await this.throwError(res, "运行失败");
    }

    if (!res.body) {
      throw new Error("PTH 未返回 SSE 流");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") return;
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            // SSE 信封：{seq, type, data, terminal, timestamp}——解包，data 为真正事件数据
            yield {
              type: (parsed.type as string) ?? "unknown",
              data: (parsed.data ?? parsed) as Record<string, unknown>,
            };
          } catch {
            // 忽略解析失败的行
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** 统一错误处理 */
  private async throwError(res: Response, prefix: string): Promise<never> {
    if (res.status === 401) {
      throw new Error(`${prefix}: Token 无效 (401)。检查 pit config get pth.token`);
    }
    if (res.status === 404) {
      throw new Error(`${prefix}: 路由不存在 (404)。PTH 可能版本过旧，请升级`);
    }
    let body = "";
    try {
      body = await res.text();
    } catch { /* ignore */ }
    throw new Error(`${prefix}: HTTP ${res.status}${body ? " — " + body : ""}`);
  }
}
