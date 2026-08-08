import { ModelRuntime, type ModelRuntimeInstance } from "../sdk-adapter/index.js";
import type { CredentialProvider } from "../credential-provider.js";
import type { Logger } from "../observability/logger.js";
import { resolveSdkConfigPaths } from "../sdk-paths.js";

type ResolvedModel = ReturnType<ModelRuntimeInstance["getModel"]>;

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
  private runtime: ModelRuntimeInstance | null = null;
  private detectedProvider: string | null = null;
  private detectedModel: string | null = null;

  constructor(
    private credentials: CredentialProvider,
    private logger: Logger,
    private config: ModelRouterConfig = DEFAULT_CONFIG,
  ) {}

  async initialize(): Promise<void> {
    this.runtime = await ModelRuntime.create({ allowModelNetwork: false, ...resolveSdkConfigPaths() });
    for (const provider of this.config.failoverOrder) {
      const key = await this.credentials.getApiKey("platform", provider);
      if (key) {
        this.runtime.setRuntimeApiKey(provider, key);
        this.logger.info({ provider, event: "credential_loaded" });
      }
    }
    // Auto-detect first available model as fallback default
    const available = await this.runtime.getAvailable();
    if (available.length > 0) {
      // Prefer env var override, then first available
      const envProvider = process.env.PI_PLATFORM_PROVIDER;
      const envModel = process.env.PI_PLATFORM_MODEL;
      if (envProvider && envModel) {
        this.detectedProvider = envProvider;
        this.detectedModel = envModel;
      } else {
        this.detectedProvider = available[0].provider;
        this.detectedModel = available[0].id;
      }
      this.logger.info({ provider: this.detectedProvider, model: this.detectedModel, event: "default_model_detected" });
    }
  }

  getRuntime(): ModelRuntimeInstance {
    if (!this.runtime) throw new Error("ModelRouter not initialized");
    return this.runtime;
  }

  resolve(provider?: string, model?: string): NonNullable<ResolvedModel> {
    const rt = this.getRuntime();
    const p = provider ?? this.detectedProvider ?? this.config.defaultProvider;
    const m = model ?? this.detectedModel ?? this.config.defaultModel;
    const resolved = rt.getModel(p, m);
    if (resolved) return resolved;

    this.logger.warn({ provider: p, model: m, event: "model_not_found" });

    // Try failover order
    for (const fp of this.config.failoverOrder) {
      if (fp === p) continue;
      const fallback = rt.getModel(fp, m);
      if (fallback) {
        this.logger.info({ provider: fp, model: m, event: "model_failover" });
        return fallback;
      }
    }

    // Last resort: use auto-detected default
    if (this.detectedProvider && this.detectedModel) {
      const lastResort = rt.getModel(this.detectedProvider, this.detectedModel);
      if (lastResort) {
        this.logger.info({ provider: this.detectedProvider, model: this.detectedModel, event: "model_last_resort" });
        return lastResort;
      }
    }

    throw new Error(`Model ${p}/${m} not found and no failover available`);
  }
}
