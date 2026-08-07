// src/ptl/session-registry.ts — 会话注册表：持久化运行地基（纯逻辑，无 pi/ink 依赖）
import fs from "node:fs";
import path from "node:path";

export interface RegistryEntry {
  name: string;
  templateId: string;
  model?: string;
  provider?: string;
  thinking?: string;
  extraArgs?: string[];
  startedAt: number;
  pid?: number | null;
  /** 本会话正在使用的纸带 id（resume 直记；fresh 启动后探测）——restore 精确恢复依据 */
  sessionId?: string;
}

export interface SessionRegistry {
  version: 1;
  sessions: Record<string, RegistryEntry>;
}

export function registryPath(dataDir: string): string {
  return path.join(dataDir, "state", "sessions.json");
}

const EMPTY = (): SessionRegistry => ({ version: 1, sessions: {} });

export function loadRegistry(dataDir: string): SessionRegistry {
  const p = registryPath(dataDir);
  if (!fs.existsSync(p)) return EMPTY();
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as SessionRegistry;
    if (raw && typeof raw === "object" && raw.version === 1 && raw.sessions && typeof raw.sessions === "object") {
      return raw;
    }
    throw new Error("bad shape");
  } catch {
    try { fs.copyFileSync(p, p + ".bak"); } catch { /* 备份失败忽略 */ }
    return EMPTY();
  }
}

export function saveRegistry(reg: SessionRegistry, dataDir: string): void {
  const p = registryPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { flag: "w" });
  fs.renameSync(tmp, p); // 原子替换
}

/** 读-改-写；写前文件被并发改动时重读重写一次 */
export function markStarted(entry: RegistryEntry, dataDir: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = fs.existsSync(registryPath(dataDir)) ? fs.statSync(registryPath(dataDir)).mtimeMs : 0;
    const reg = loadRegistry(dataDir);
    reg.sessions[entry.name] = entry;
    saveRegistry(reg, dataDir);
    const after = fs.statSync(registryPath(dataDir)).mtimeMs;
    if (after === before && attempt === 0) continue; // 理论上不会命中；保守重试
    return;
  }
}

export function markStopped(name: string, dataDir: string): void {
  const reg = loadRegistry(dataDir);
  if (reg.sessions[name]) {
    delete reg.sessions[name];
    saveRegistry(reg, dataDir);
  }
}
