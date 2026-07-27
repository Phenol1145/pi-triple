import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialProvider } from "../storage/interfaces.js";
import type { Logger } from "../observability/logger.js";

type ResolvedModel = ReturnType<ModelRuntime["getModel"]>;

export interface ModelRouterConfig {
  defaultProvider: string;
  defaultModel: string;
  failoverOrder: string[];
}

const DEFAULT_CONFIG: ModelRouterConfig = {
  defaultProvider: "anthropic",
  defaultModel: "claude-sonnet-4-20250514",
  failoverOrder: ["anthropic", "openai", "google"],
};

export class ModelRouter {
  private runtime: ModelRuntime | null = null;

  constructor(
    private credentials: CredentialProvider,
    private logger: Logger,
    private config: ModelRouterConfig = DEFAULT_CONFIG,
  ) {}

  async initialize(): Promise<void> {
    this.runtime = await ModelRuntime.create();
    for (const provider of this.config.failoverOrder) {
      const key = await this.credentials.getApiKey("platform", provider);
      if (key) {
        this.runtime.setRuntimeApiKey(provider, key);
        this.logger.info({ provider, event: "credential_loaded" });
      }
    }
  }

  getRuntime(): ModelRuntime {
    if (!this.runtime) throw new Error("ModelRouter not initialized");
    return this.runtime;
  }

  resolve(provider?: string, model?: string): NonNullable<ResolvedModel> {
    const rt = this.getRuntime();
    const p = provider ?? this.config.defaultProvider;
    const m = model ?? this.config.defaultModel;
    const resolved = rt.getModel(p, m);
    if (!resolved) {
      this.logger.warn({ provider: p, model: m, event: "model_not_found" });
      for (const fp of this.config.failoverOrder) {
        if (fp === p) continue;
        const fallback = rt.getModel(fp, m);
        if (fallback) {
          this.logger.info({ provider: fp, model: m, event: "model_failover" });
          return fallback;
        }
      }
      throw new Error(`Model ${p}/${m} not found and no failover available`);
    }
    return resolved;
  }
}
