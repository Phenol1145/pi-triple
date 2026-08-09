export const OR_MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface FetchJsonOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onParentAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  try {
    const res = await f(url, { signal: ctrl.signal, headers: opts.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onParentAbort);
  }
}
