/**
 * pit-providers — 统一 Provider 后端
 *
 * 从 providers.json 加载声明式 provider 定义，
 * 自动 registerProvider + /keys 多 Key 管理 + 401/403 failover。
 *
 * 单一 entry：export default function(pi) 由 pi 扩展加载器调用。
 */
import fs from "node:fs";
import path from "node:path";
import { loadProviders, ensureDefaultProviders } from "./registry.js";
import { ProviderManager } from "./manager.js";
import { getNextAvailableKey, generateId } from "./keypool.js";
import { registerFailover } from "./failover.js";
import { inferModel } from "./infer.js";
import type { ProviderDef, KeyPool, KeyEntry, ModelDef } from "./types.js";

// ─── 双注册防护 ──────────────────────────────────────────────

/** 检查共享层的 extensions/ 目录下是否存在旧扩展 */
function hasLegacyExtension(): { kimi: boolean; ustc: boolean } {
  // __dirname 在 ESM 中为 import.meta 的产物；pi 扩展环境类似。
  // 这里用 PI_CODING_AGENT_DIR 下的 extensions/ 路径检测。
  const dir = process.env.PI_CODING_AGENT_DIR;
  const extDir = dir ? path.join(dir, "extensions") : null;
  if (!extDir) return { kimi: false, ustc: false };
  return {
    kimi: fs.existsSync(path.join(extDir, "kimi-platform")),
    ustc: fs.existsSync(path.join(extDir, "ustc-llm")),
  };
}

// ─── Provider 注册 ───────────────────────────────────────────

const FAR_FUTURE = 9999999999999;

/**
 * 创建单 Key provider 的 registerProvider options（无 oauth）。
 */
function simpleProviderOpts(def: ProviderDef) {
  return {
    name: def.name,
    baseUrl: def.baseUrl,
    api: def.api as any,
    apiKey: def.apiKeyEnv ? `$${def.apiKeyEnv}` : undefined,
    compat: def.compat,
    models: def.models.map((m) => ({ ...m })),
  };
}

/**
 * 创建多 Key provider 的 registerProvider options（含 oauth + refreshModels）。
 *
 * manager 持有此 provider 的 KeyPool 生命周期。
 */
function multiKeyProviderOpts(def: ProviderDef, manager: ProviderManager) {
  const opts: Record<string, unknown> = {
    name: def.name,
    baseUrl: def.baseUrl,
    api: def.api as any,
    compat: def.compat,
    models: def.models.map((m) => ({ ...m })),
  };

  // 空池兜底：env 变量
  if (def.apiKeyEnv) {
    opts.apiKey = `$${def.apiKeyEnv}`;
  }

  // oauth 回调：/login 交互 + failover 钩子的持久化后端
  opts.oauth = {
    name: `${def.name}（多 Key 管理 + 自动 Failover）`,
    login: async (cb: any) => {
      return loginProvider(cb, manager);
    },
    refreshToken: async (_cred: any) => {
      // FAR_FUTURE → pi 永不调用；保留为防御性回调
      const pool = manager.loadPool();
      const key = getNextAvailableKey(pool);
      return {
        refresh: JSON.stringify(pool),
        access: key?.key ?? "",
        expires: FAR_FUTURE,
      };
    },
    getApiKey: (_cred: any) => {
      return manager.getApiKey();
    },
  };

  // 动态模型列表（refreshModels = true）
  if (def.refreshModels) {
    opts.refreshModels = async (ctx: any) => {
      return refreshModels(ctx, manager, def);
    };
  }

  return opts;
}

// ─── /login 交互 ─────────────────────────────────────────────

async function loginProvider(
  callbacks: { input: (prompt: string) => Promise<string>; ui: { select: (title: string, items: string[]) => Promise<string | undefined>; notify: (text: string, level?: string) => void } },
  manager: ProviderManager,
): Promise<{ refresh: string; access: string; expires: number }> {
  let pool = manager.loadPool();

  // 尝试从 auth.json 旧格式迁移未入池的 Key
  if (pool.keys.length === 0) {
    const ap = manager.authPath();
    if (ap && fs.existsSync(ap)) {
      try {
        const raw = JSON.parse(fs.readFileSync(ap, "utf-8"));
        const cred = raw[manager.id];
        if (cred?.refresh) {
          pool = JSON.parse(cred.refresh) as KeyPool;
        } else if (cred?.access && cred.access.length > 10) {
          pool.keys.push({ id: generateId(), alias: "默认", key: cred.access, failed: false });
          pool.activeId = pool.keys[0].id;
        } else if (cred?.key && cred.key.length > 10) {
          pool.keys.push({ id: generateId(), alias: "默认", key: cred.key, failed: false });
          pool.activeId = pool.keys[0].id;
        }
      } catch { /* ignore */ }
    }
  }

  while (true) {
    // 构造菜单
    const items: string[] = [];
    if (pool.keys.length > 0) {
      items.push("⇄ 切换 Active Key");
    }
    items.push("🔑 添加新 Key");
    if (pool.keys.length > 0) {
      items.push("🗑 删除 Key");
    }
    items.push("✓ 完成");

    const labels = pool.keys.length > 0
      ? pool.keys.map((k) => {
          const marker = k.id === pool.activeId ? " ← 当前" : "";
          const failMark = k.failed ? " [失效]" : "";
          return `  ${k.alias}${marker}${failMark}`;
        })
      : ["  (暂无 Key)"];

    const menuText = [
      `${manager.name} Key 管理 (${pool.keys.length} 个)`,
      "──────────────────────",
      ...labels,
      "──────────────────────",
    ].join("\n");

    const choice = await callbacks.ui.select(menuText, items);
    if (!choice || choice.startsWith("✓")) break;

    if (choice.startsWith("⇄")) {
      const keyItems = pool.keys.map((k) => {
        const marker = k.id === pool.activeId ? " ← 当前" : "";
        const failMark = k.failed ? " [失效]" : "";
        return `${k.alias}${marker}${failMark}`;
      });
      const sel = await callbacks.ui.select("选择要激活的 Key", keyItems);
      if (!sel) continue;
      const idx = keyItems.indexOf(sel);
      if (idx >= 0 && idx < pool.keys.length) {
        pool.activeId = pool.keys[idx].id;
        manager.savePool(pool);
        callbacks.ui.notify(`已切换到 "${pool.keys[idx].alias}"`, "info");
      }
      continue;
    }

    if (choice.startsWith("🔑")) {
      const name = await callbacks.input("Key 别名（可选，如 'key1'）:") || "";
      const key = await callbacks.input("API Key:") || "";
      if (key.trim().length < 10) {
        callbacks.ui.notify("API Key 太短，跳过", "warning");
        continue;
      }
      pool.keys.push({
        id: generateId(),
        alias: name.trim() || `Key-${pool.keys.length + 1}`,
        key: key.trim(),
        failed: false,
      });
      if (!pool.activeId || !pool.keys.find((k) => k.id === pool.activeId)) {
        pool.activeId = pool.keys[0].id;
      }
      manager.savePool(pool);
      callbacks.ui.notify(`已添加 "${name || `Key-${pool.keys.length}`}"`, "info");
      continue;
    }

    if (choice.startsWith("🗑")) {
      const keyItems = pool.keys.map((k) => {
        const marker = k.id === pool.activeId ? " ← 当前" : "";
        return `${k.alias}${marker}`;
      });
      const sel = await callbacks.ui.select("选择要删除的 Key", keyItems);
      if (!sel) continue;
      const idx = keyItems.indexOf(sel);
      if (idx >= 0 && idx < pool.keys.length) {
        const removed = pool.keys[idx];
        pool.keys = pool.keys.filter((_, i) => i !== idx);
        if (pool.activeId === removed.id && pool.keys.length > 0) {
          pool.activeId = pool.keys[0].id;
        } else if (pool.keys.length === 0) {
          pool.activeId = "";
        }
        manager.savePool(pool);
        callbacks.ui.notify(`已删除 "${removed.alias}"`, "info");
      }
      continue;
    }
  }

  const active = getNextAvailableKey(pool);
  return {
    refresh: JSON.stringify(pool),
    access: active?.key ?? "",
    expires: FAR_FUTURE,
  };
}

// ─── refreshModels ───────────────────────────────────────────

async function refreshModels(
  ctx: any,
  manager: ProviderManager,
  def: ProviderDef,
): Promise<any[] | void> {
  if (ctx.allowNetwork) {
    const apiKey = manager.getApiKey();
    if (apiKey) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        if (ctx.signal) {
          ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        const resp = await fetch(`${def.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        clearTimeout(t);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as any;
        const ids: string[] = (data?.data ?? []).map((m: any) => m.id).filter(Boolean);
        if (ctx.signal?.aborted) return;
        if (ids.length > 0) {
          const models = buildModelsForIds(ids, def);
          await ctx.store.write({ models, checkedAt: Date.now() });
          return models;
        }
      } catch {
        // 拉取失败，回退到缓存
      }
    }
  }

  // 离线 / 失败：用缓存中的模型 ID 重新套用当前规格
  const cached = await ctx.store.read();
  if (cached?.models && cached.models.length > 0) {
    return buildModelsForIds(
      cached.models.map((m: any) => m.id),
      def,
    );
  }
}

/** 按模型 ID 列表构建 ModelDef[]：
 *   在静态 models（SPECS 查找表）中查找 → 命中复用元数据
 *   未命中走 inferRules 推断 */
function buildModelsForIds(ids: string[], def: ProviderDef): ModelDef[] {
  const lookups = new Map(def.models.map((m) => [m.id, m]));
  return ids.map((id) => {
    const staticDef = lookups.get(id);
    if (staticDef) {
      // quirk (spec): refresh 路径强制 cacheWrite: 0
      return {
        ...staticDef,
        cost: staticDef.cost ? { ...staticDef.cost, cacheWrite: 0 } : undefined,
      };
    }
    // 推断
    return {
      ...inferModel(id, def.inferRules, def.inferDefaults),
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        ...(def.inferDefaults?.cost ?? {}),
      },
    };
  });
}

// ─── /keys 命令 ──────────────────────────────────────────────

function keyLabel(k: KeyEntry, activeId: string): string {
  const mark = k.id === activeId ? " ← active" : "";
  const fail = k.failed ? " [失效]" : "";
  return `${k.alias}${mark}${fail}`;
}

async function switchActiveKey(ctx: any, manager: ProviderManager): Promise<void> {
  const pool = manager.loadPool();
  if (pool.keys.length === 0) {
    ctx.ui.notify(`没有已注册的 Key。用 /login ${manager.id} 添加。`, "warning");
    return;
  }
  const choice = await ctx.ui.select(
    "选择要激活的 Key",
    pool.keys.map((k: KeyEntry) => keyLabel(k, pool.activeId)),
  );
  if (!choice) return;
  const idx = pool.keys.findIndex((k: KeyEntry) => keyLabel(k, pool.activeId) === choice);
  if (idx < 0) return;
  const selected = pool.keys[idx];
  if (selected.id === pool.activeId) {
    ctx.ui.notify(`"${selected.alias}" 已是当前 Key`, "info");
    return;
  }
  const next = { ...pool, activeId: selected.id };
  manager.savePool(next);
  ctx.ui.notify(`已切换到 "${selected.alias}"，正在刷新模型列表...`, "info");
  try {
    await ctx.modelRegistry.refresh();
    ctx.ui.notify(`模型列表已按 "${selected.alias}" 更新`, "info");
  } catch {
    ctx.ui.notify("模型刷新失败，但 Key 已切换", "warning");
  }
}

async function checkAllKeys(ctx: any, manager: ProviderManager): Promise<void> {
  const pool = manager.loadPool();
  if (pool.keys.length === 0) {
    ctx.ui.notify(`没有已注册的 Key。用 /login ${manager.id} 添加。`, "warning");
    return;
  }

  const next = { ...pool, keys: pool.keys.map((k: KeyEntry) => ({ ...k })) };
  const lines: string[] = [`${manager.name} Key 探测结果:`, "──────────────────────"];

  for (let i = 0; i < next.keys.length; i++) {
    const k = next.keys[i];
    ctx.ui.setStatus("keys-check", `正在探测 "${k.alias}" (${i + 1}/${next.keys.length})...`);
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`${manager.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${k.key}` },
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const data = (await resp.json()) as any;
      const ids: string[] = (data?.data ?? []).map((m: any) => m.id).filter(Boolean);
      next.keys[i] = { ...next.keys[i], failed: false };
      const mark = k.id === pool.activeId ? " ← active" : "";
      lines.push(`✓ ${k.alias}: ${ids.length} 个模型${mark}`);
    } catch (e: any) {
      const msg = e.message || String(e);
      const isAuth = /^HTTP (401|403)\b/.test(msg);
      next.keys[i] = { ...next.keys[i], failed: isAuth };
      const tag = isAuth ? " [已标记失效]" : " (瞬时失败，状态不变)";
      lines.push(`✗ ${k.alias}: ${msg}${tag}`);
    }
  }
  ctx.ui.setStatus("keys-check", undefined);

  // active Key 认证失败 → 自动切换
  if (next.activeId) {
    const active = next.keys.find((k: KeyEntry) => k.id === next.activeId);
    if (active?.failed) {
      const alt = next.keys.find((k: KeyEntry) => !k.failed);
      if (alt) {
        next.activeId = alt.id;
        lines.push("──────────────────────");
        lines.push(`⚠ active Key 认证失败，已自动切换到 "${alt.alias}"`);
      }
    }
  }
  manager.savePool(next);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function listActiveModels(ctx: any, manager: ProviderManager): Promise<void> {
  const pool = manager.loadPool();
  const active = pool.keys.find((k: KeyEntry) => k.id === pool.activeId);
  if (!active) {
    ctx.ui.notify(`没有 active Key。用 /login ${manager.id} 添加。`, "warning");
    return;
  }

  ctx.ui.setStatus("keys-list", `正在拉取 "${active.alias}" 的模型列表...`);
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`${manager.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${active.key}` },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const data = (await resp.json()) as any;
    const ids: string[] = (data?.data ?? []).map((m: any) => m.id).filter(Boolean);
    ctx.ui.setStatus("keys-list", undefined);
    const lines = [
      `Active Key: ${active.alias} (${active.key.slice(0, 6)}...${active.key.slice(-4)})`,
      `可访问模型 (${ids.length}):`,
      "──────────────────────",
      ...ids.map((id: string) => `  • ${id}`),
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  } catch (e: any) {
    ctx.ui.setStatus("keys-list", undefined);
    ctx.ui.notify(`拉取失败: ${e.message}`, "error");
  }
}

// ─── Entry Point ─────────────────────────────────────────────

export default function pitProviders(pi: any) {
  // 确保 providers.json 存在
  ensureDefaultProviders();

  // 加载 provider 定义
  const { providers, errors } = loadProviders();

  if (errors.length > 0) {
    process.stderr.write(`[pit-providers] providers.json 警告:\n`);
    for (const e of errors) {
      process.stderr.write(`  ${e}\n`);
    }
  }

  if (providers.length === 0) {
    process.stderr.write("[pit-providers] 没有有效的 provider 定义，扩展未注册任何 provider\n");
    return;
  }

  // 双注册防护：检测旧扩展
  const legacy = hasLegacyExtension();

  // 收集所有 multiKey manager（failover / /keys 用）
  const multiKeyManagers = new Map<string, ProviderManager>();

  // 按 providerId 索引所有 manager（failover 查找用）
  const allManagers = new Map<string, ProviderManager>();

  for (const def of providers) {
    const manager = new ProviderManager(def);
    allManagers.set(def.id, manager);
    // 也按 alias[0] 索引（/keys 匹配 + failover）
    if (def.alias && def.alias.length > 0) {
      allManagers.set(def.alias[0], manager);
    }

    // 双注册防护：检测对应旧扩展
    const skipKimi = legacy.kimi && def.id === "kimi";
    const skipUstc = legacy.ustc && (def.id === "ustc-llm" || def.id === "suntomb");
    if (skipKimi || skipUstc) {
      const oldExt = skipKimi ? "kimi-platform" : "ustc-llm";
      process.stderr.write(
        `[pit-providers] ⚠ 检测到旧扩展 "${oldExt}"，跳过 ${def.name} provider 注册。\n` +
        `  请删除共享层 extensions/ 中的 "${oldExt}" 目录后重启 pi。\n`,
      );
      continue;
    }

    // 迁移旧 Key 池（multiKey 且 providerId match）
    if (def.multiKey) {
      manager.migrateLegacy();
      multiKeyManagers.set(def.id, manager);
    }

    if (def.multiKey) {
      pi.registerProvider(def.id, multiKeyProviderOpts(def, manager));
    } else {
      pi.registerProvider(def.id, simpleProviderOpts(def));
    }
  }

  // /keys 命令（仅 multiKey provider）
  if (multiKeyManagers.size > 0) {
    pi.registerCommand("keys", {
      description: "管理多 API Key: /keys <provider> [switch|check|list]",
      getArgumentCompletions: (prefix: string) => {
        const p = prefix.trim().split(/\s+/)[0] ?? "";
        // 第一级：provider 名称（支持 id 和 alias）
        const candidates = new Set<string>();
        for (const [id, mgr] of allManagers) {
          if (mgr.multiKey) {
            candidates.add(id);
            if (mgr.def.alias) {
              for (const a of mgr.def.alias) candidates.add(a);
            }
          }
        }
        const filtered = [...candidates].filter((c) => c.startsWith(p.toLowerCase()));
        return filtered.length > 0
          ? filtered.map((c) => ({
              value: c,
              label: c,
              description: allManagers.get(c)?.name ?? "",
            }))
          : null;
      },
      handler: async (args: string, ctx: any) => {
        const parts = (args || "").trim().split(/\s+/).filter(Boolean);
        let manager: ProviderManager | undefined;
        let sub: string | undefined;

        if (parts.length === 0) {
          if (multiKeyManagers.size === 1) {
            manager = Array.from(multiKeyManagers.values())[0];
          } else {
            const opts = Array.from(multiKeyManagers.values()).map(
              (m) => `${m.alias} — ${m.name}`,
            );
            const choice = await ctx.ui.select("选择 provider", opts);
            if (!choice) return;
            const alias = choice.split(" — ")[0].toLowerCase();
            manager = Array.from(multiKeyManagers.values()).find(
              (m) =>
                m.alias === alias ||
                m.def.alias?.includes(alias) ||
                m.id === alias,
            );
          }
        } else {
          // 按 alias 或 id 查找
          const key = parts[0].toLowerCase();
          manager = Array.from(multiKeyManagers.values()).find(
            (m) =>
              m.alias === key ||
              m.def.alias?.includes(key) ||
              m.id === key,
          );
          sub = parts[1]?.toLowerCase();
        }

        if (!manager) {
          const avail = Array.from(multiKeyManagers.values())
            .map((m) => m.alias)
            .join(", ");
          ctx.ui.notify(`未知 provider。可用: ${avail}`, "warning");
          return;
        }

        if (sub === "switch") return switchActiveKey(ctx, manager);
        if (sub === "check") return checkAllKeys(ctx, manager);
        if (sub === "list" || sub === "models") return listActiveModels(ctx, manager);

        // 无子命令：状态 + 菜单
        const pool = manager.loadPool();
        if (pool.keys.length === 0) {
          ctx.ui.notify(
            `没有已注册的 Key。用 /login ${manager.id} 添加。`,
            "warning",
          );
          return;
        }
        const active = pool.keys.find((k: KeyEntry) => k.id === pool.activeId);
        const statusLines = [
          `${manager.name} Key 状态`,
          "──────────────────────",
          ...pool.keys.map((k: KeyEntry) => keyLabel(k, pool.activeId)),
          "──────────────────────",
          `Active: ${active?.alias ?? "无"}`,
        ];
        const choice = await ctx.ui.select(statusLines.join("\n"), [
          "⇄ 切换 Active Key",
          "🔍 检查所有 Key 可用性",
          "📋 查看当前 Key 的模型列表",
        ]);
        if (!choice) return;
        if (choice.startsWith("⇄")) return switchActiveKey(ctx, manager);
        if (choice.startsWith("🔍")) return checkAllKeys(ctx, manager);
        if (choice.startsWith("📋")) return listActiveModels(ctx, manager);
      },
    });
  }

  // failover hook
  if (multiKeyManagers.size > 0) {
    registerFailover(pi, allManagers);
  }
}
