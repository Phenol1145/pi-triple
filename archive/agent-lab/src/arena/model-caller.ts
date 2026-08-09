import { complete } from "@earendil-works/pi-ai/compat";
import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelCaller } from "./types.ts";

export function createModelCaller(ctx: ExtensionContext): ModelCaller {
  const reg = ctx.modelRegistry;
  return {
    async complete(modelId: string, prompt: string, timeoutMs: number): Promise<string> {
      let model = reg.find("openrouter", modelId);
      if (!model && modelId.includes("/")) {
        const idx = modelId.indexOf("/");
        model = reg.find(modelId.slice(0, idx), modelId.slice(idx + 1));
      }
      if (!model) throw new Error("model not in registry: " + modelId);
      if (!reg.hasConfiguredAuth(model)) throw new Error("no configured auth: " + modelId);
      const auth = await reg.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error("auth failed: " + auth.error);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const msg = await complete(model as never, { messages: [{ role: "user", content: prompt }] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctrl.signal });
        return contentText(msg.content);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
