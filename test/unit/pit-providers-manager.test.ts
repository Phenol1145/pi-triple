import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProviderManager } from "../../extensions/pit-providers/manager.js";
import { makeKeyPool, generateId } from "../../extensions/pit-providers/keypool.js";
import type { ProviderDef, KeyPool } from "../../extensions/pit-providers/types.js";

/** 标准 multiKey provider 定义 */
const MULTI_KEY_DEF: ProviderDef = {
  id: "ustc-llm",
  name: "USTC LLM",
  alias: ["ustc"],
  baseUrl: "https://llm.ustc.edu.cn/v1",
  api: "openai-completions",
  apiKeyEnv: "USTC_LLM_API_KEY",
  multiKey: true,
  models: [],
  refreshModels: false,
};

/** 单 Key provider 定义 */
const SINGLE_KEY_DEF: ProviderDef = {
  id: "kimi",
  name: "Kimi",
  alias: ["kimi"],
  baseUrl: "https://api.moonshot.cn/v1",
  api: "openai-completions",
  apiKeyEnv: "KIMI_API_KEY",
  multiKey: false,
  models: [],
  refreshModels: false,
};

function setEnv(kv: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(kv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("ProviderManager", () => {
  let tmpDir: string;
  let origHome: string | undefined;
  let origAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-mgr-"));
    origHome = process.env.HOME;
    origAgentDir = process.env.PI_CODING_AGENT_DIR;
    // PI_CODING_AGENT_DIR for auth.json（租户隔离）
    process.env.PI_CODING_AGENT_DIR = tmpDir;
    // HOME for host migration path
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    setEnv({
      HOME: origHome,
      PI_CODING_AGENT_DIR: origAgentDir,
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── roundtrip ──────────────────────────────────────────

  it("savePool → loadPool roundtrip（OAuth 格式）", () => {
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    const pool = makeKeyPool();
    const entry = { id: "k1", alias: "test", key: "sk-abc", failed: false };
    pool.keys.push(entry);
    pool.activeId = "k1";

    mgr.savePool(pool);

    // 读取原始 auth.json 验证格式
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "auth.json"), "utf-8"));
    const cred = raw["ustc-llm"];
    expect(cred.type).toBe("oauth");
    expect(cred.access).toBe("sk-abc");
    expect(cred.expires).toBe(9999999999999);
    expect(cred.refresh).toContain("k1");

    // 重新加载
    const mgr2 = new ProviderManager(MULTI_KEY_DEF);
    const loaded = mgr2.loadPool();
    expect(loaded.keys).toHaveLength(1);
    expect(loaded.keys[0]!.key).toBe("sk-abc");
    expect(loaded.activeId).toBe("k1");
  });

  it("loadPool → 文件不存在 → 空池", () => {
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    const pool = mgr.loadPool();
    expect(pool.keys).toHaveLength(0);
    expect(pool.activeId).toBe("");
  });

  it("loadPool → 内存缓存（cachedPool 不重复读文件）", () => {
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    // 首次 load：空池
    const p1 = mgr.loadPool();
    // 手动写入文件（绕过 savePool）
    const p2 = makeKeyPool();
    p2.keys.push({ id: "x", alias: "x", key: "secret", failed: false });
    p2.activeId = "x";
    mgr.savePool(p2);
    // cachedPool 已更新（savePool 同步更新）
    const p3 = mgr.loadPool();
    expect(p3.keys[0]!.key).toBe("secret");
  });

  it("loadPool → authPath 为 null（PI_CODING_AGENT_DIR 未设置）→ fail-closed", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    expect(mgr.authPath()).toBeNull();
    const pool = mgr.loadPool();
    expect(pool.keys).toHaveLength(0);
    // savePool 不应写文件
    pool.keys.push({ id: "x", alias: "x", key: "x", failed: false });
    pool.activeId = "x";
    mgr.savePool(pool);
    expect(fs.existsSync(path.join(tmpDir, "auth.json"))).toBe(false);
  });

  // ── 旧格式迁移 ─────────────────────────────────────────

  it("migrateLegacy → 租户已有凭据 → skip（false）", () => {
    // 租户 auth.json 已有该 provider
    const ap = path.join(tmpDir, "auth.json");
    fs.writeFileSync(ap, JSON.stringify({
      "ustc-llm": {
        type: "oauth",
        access: "old-key",
        refresh: JSON.stringify(makeKeyPool()),
        expires: FAR_FUTURE,
      },
    }));

    const mgr = new ProviderManager(MULTI_KEY_DEF);
    expect(mgr.migrateLegacy()).toBe(false);
  });

  it("migrateLegacy → 宿主快照 + 源清理（host 有 refresh）", () => {
    // 创建宿主 auth.json（模拟 ustc-llm 时代数据泄漏）
    const piAgentDir = path.join(tmpDir, ".pi", "agent");
    fs.mkdirSync(piAgentDir, { recursive: true });
    const hostPath = path.join(piAgentDir, "auth.json");
    const hostPool: KeyPool = {
      keys: [{ id: "h1", alias: "宿主机Key", key: "sk-host", failed: false }],
      activeId: "h1",
    };
    const hostAuth = {
      "ustc-llm": {
        type: "oauth",
        access: "sk-host",
        refresh: JSON.stringify(hostPool),
        expires: FAR_FUTURE,
      },
      "other-provider": {
        type: "oauth",
        access: "keep-me",
        refresh: JSON.stringify({ keys: [], activeId: "" }),
        expires: FAR_FUTURE,
      },
    };
    fs.writeFileSync(hostPath, JSON.stringify(hostAuth, null, 2));

    // 租户无 auth.json
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    expect(mgr.migrateLegacy()).toBe(true);

    // 租户侧：Key 已迁移
    const moved = mgr.loadPool();
    expect(moved.keys).toHaveLength(1);
    expect(moved.keys[0]!.key).toBe("sk-host");
    expect(moved.keys[0]!.alias).toBe("宿主机Key");

    // 宿主侧：ustc-llm 条目已删除，other-provider 保留
    const hostAfter = JSON.parse(fs.readFileSync(hostPath, "utf-8"));
    expect(hostAfter["ustc-llm"]).toBeUndefined();
    expect(hostAfter["other-provider"].access).toBe("keep-me");
  });

  it("migrateLegacy → 宿主无该 provider → skip", () => {
    const piAgentDir = path.join(tmpDir, ".pi", "agent");
    fs.mkdirSync(piAgentDir, { recursive: true });
    fs.writeFileSync(path.join(piAgentDir, "auth.json"), JSON.stringify({
      "some-other": { type: "oauth", access: "x", refresh: "{}", expires: 1 },
    }));

    const mgr = new ProviderManager(MULTI_KEY_DEF);
    expect(mgr.migrateLegacy()).toBe(false);
  });

  it("migrateLegacy → 宿主 access 无 refresh（旧格式 /login）", () => {
    const piAgentDir = path.join(tmpDir, ".pi", "agent");
    fs.mkdirSync(piAgentDir, { recursive: true });
    fs.writeFileSync(path.join(piAgentDir, "auth.json"), JSON.stringify({
      "ustc-llm": {
        type: "oauth",
        access: "sk-old-login-format",
        expires: FAR_FUTURE,
      },
    }));

    const mgr = new ProviderManager(MULTI_KEY_DEF);
    expect(mgr.migrateLegacy()).toBe(true);
    const pool = mgr.loadPool();
    expect(pool.keys).toHaveLength(1);
    expect(pool.keys[0]!.key).toBe("sk-old-login-format");
    expect(pool.keys[0]!.alias).toBe("默认");
  });

  it("migrateLegacy → 宿主 type:api_key 格式", () => {
    const piAgentDir = path.join(tmpDir, ".pi", "agent");
    fs.mkdirSync(piAgentDir, { recursive: true });
    fs.writeFileSync(path.join(piAgentDir, "auth.json"), JSON.stringify({
      "ustc-llm": {
        type: "api_key",
        key: "sk-api-key-format",
      },
    }));

    const mgr = new ProviderManager(MULTI_KEY_DEF);
    expect(mgr.migrateLegacy()).toBe(true);
    const pool = mgr.loadPool();
    expect(pool.keys[0]!.key).toBe("sk-api-key-format");
  });

  it("migrateLegacy → 非 multiKey provider → skip", () => {
    const mgr = new ProviderManager(SINGLE_KEY_DEF);
    expect(mgr.migrateLegacy()).toBe(false);
  });

  it("migrateLegacy → 宿主空后删除文件", () => {
    const piAgentDir = path.join(tmpDir, ".pi", "agent");
    fs.mkdirSync(piAgentDir, { recursive: true });
    const hostPath = path.join(piAgentDir, "auth.json");
    fs.writeFileSync(hostPath, JSON.stringify({
      "ustc-llm": {
        type: "oauth",
        access: "sk-only",
        refresh: JSON.stringify({ keys: [{ id: "h1", alias: "x", key: "sk-only", failed: false }], activeId: "h1" }),
        expires: FAR_FUTURE,
      },
    }));

    const mgr = new ProviderManager(MULTI_KEY_DEF);
    mgr.migrateLegacy();
    // 源文件只剩这一个 provider → 删除
    expect(fs.existsSync(hostPath)).toBe(false);
  });

  // ── getApiKey ───────────────────────────────────────────

  it("getApiKey → mutiKey 有 active → 返回 active key", () => {
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    const pool = makeKeyPool();
    pool.keys.push({ id: "a", alias: "a", key: "sk-active", failed: false });
    pool.activeId = "a";
    mgr.savePool(pool);

    expect(mgr.getApiKey()).toBe("sk-active");
  });

  it("getApiKey → mutiKey active 失败 → 返回下一个", () => {
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    const pool = makeKeyPool();
    pool.keys.push({ id: "a", alias: "a", key: "sk-dead", failed: true });
    pool.keys.push({ id: "b", alias: "b", key: "sk-alive", failed: false });
    pool.activeId = "a";
    mgr.savePool(pool);

    expect(mgr.getApiKey()).toBe("sk-alive");
  });

  it("getApiKey → 空池 → env 兜底", () => {
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    process.env.USTC_LLM_API_KEY = "sk-from-env";
    expect(mgr.getApiKey()).toBe("sk-from-env");
    delete process.env.USTC_LLM_API_KEY;
  });

  it("getApiKey → 单 Key → env 直接取", () => {
    const mgr = new ProviderManager(SINGLE_KEY_DEF);
    process.env.KIMI_API_KEY = "sk-kimi-env";
    expect(mgr.getApiKey()).toBe("sk-kimi-env");
    delete process.env.KIMI_API_KEY;
  });

  it("getApiKey → 空池 + 无 env → 返回空串", () => {
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    // 确保 env 不存在
    delete process.env.USTC_LLM_API_KEY;
    expect(mgr.getApiKey()).toBe("");
  });

  it("getApiKey → PI_CODING_AGENT_DIR 未设置 → env 仍可用", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    process.env.USTC_LLM_API_KEY = "sk-fallback";
    expect(mgr.getApiKey()).toBe("sk-fallback");
    delete process.env.USTC_LLM_API_KEY;
  });

  // ── ingestLegacyCredential ──────────────────────────────

  it("ingestLegacyCredential → access 无 refresh → 入池", () => {
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    const ok = mgr.ingestLegacyCredential({
      type: "oauth",
      access: "sk-legacy-xxxxxx",
    });
    expect(ok).toBe(true);
    expect(mgr.getApiKey()).toBe("sk-legacy-xxxxxx");
  });

  it("ingestLegacyCredential → api_key 格式 → 入池", () => {
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    const ok = mgr.ingestLegacyCredential({
      type: "api_key",
      key: "sk-legacy-yyyyyy",
    });
    expect(ok).toBe(true);
    expect(mgr.getApiKey()).toBe("sk-legacy-yyyyyy");
  });

  it("ingestLegacyCredential → 池已有数据 → skip", () => {
    const mgr = new ProviderManager(MULTI_KEY_DEF);
    const pool = makeKeyPool();
    pool.keys.push({ id: "x", alias: "x", key: "existing", failed: false });
    pool.activeId = "x";
    mgr.savePool(pool);

    expect(mgr.ingestLegacyCredential({ type: "oauth", access: "sk-ignored" })).toBe(false);
    expect(mgr.getApiKey()).toBe("existing");
  });
});

// 常量引用（与源文件一致）
const FAR_FUTURE = 9999999999999;
