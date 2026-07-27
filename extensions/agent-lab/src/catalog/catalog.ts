import type { ModelInfo } from "../types.ts";
import { fetchJson, OR_MODELS_URL } from "./sources.ts";
import { parseORModels, type ORModelsJson } from "./parse.ts";

export interface CatalogDeps {
  directPrefixes: string[];
  ttlMs: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  now?: () => number;
}

export class CatalogService {
  private cache: ModelInfo[] = [];
  private fetchedAt = 0;
  private deps: CatalogDeps;
  constructor(deps: CatalogDeps) { this.deps = deps; }

  async refresh(): Promise<void> {
    const json = await fetchJson<ORModelsJson>(OR_MODELS_URL, {
      fetchImpl: this.deps.fetchImpl,
      headers: this.deps.headers,
    });
    this.cache = parseORModels(json, this.deps.directPrefixes);
    this.fetchedAt = (this.deps.now ?? Date.now)();
  }

  candidates(): ModelInfo[] { return [...this.cache]; }
  get lastFetched(): number { return this.fetchedAt; }
  get isFresh(): boolean { return (this.deps.now ?? Date.now)() - this.fetchedAt < this.deps.ttlMs; }
}
