// test/unit/session-registry.test.ts — task 1: 会话注册表（持久化运行地基）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registryPath, loadRegistry, saveRegistry, markStarted, markStopped,
} from "@pi-triple/shared";
import type { RegistryEntry } from "@pi-triple/shared";

describe("session-registry", () => {
  let root: string;
  const ENTRY: RegistryEntry = { name: "local-abc", templateId: "t1", model: "m1", startedAt: 1000, pid: 42 };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("registryPath 指向 dataDir/state/sessions.json", () => {
    expect(registryPath(root)).toBe(path.join(root, "state", "sessions.json"));
  });

  it("文件不存在 → 空注册表", () => {
    expect(loadRegistry(root).sessions).toEqual({});
  });

  it("save + load 往返", () => {
    const reg = { version: 1 as const, sessions: { [ENTRY.name]: ENTRY } };
    saveRegistry(reg, root);
    expect(loadRegistry(root).sessions["local-abc"]).toEqual(ENTRY);
  });

  it("损坏文件 → .bak 备份 + 空注册表（不崩溃）", () => {
    fs.writeFileSync(registryPath(root), "{broken json");
    const reg = loadRegistry(root);
    expect(reg.sessions).toEqual({});
    expect(fs.existsSync(registryPath(root) + ".bak")).toBe(true);
  });

  it("markStarted 写入条目（多次调用都生效）", () => {
    markStarted(ENTRY, root);
    markStarted({ ...ENTRY, name: "local-xyz", pid: 99 }, root);
    const reg = loadRegistry(root);
    expect(reg.sessions["local-abc"].pid).toBe(42);
    expect(reg.sessions["local-xyz"].pid).toBe(99);
  });

  it("markStopped 删除条目", () => {
    markStarted(ENTRY, root);
    markStopped("local-abc", root);
    expect(loadRegistry(root).sessions["local-abc"]).toBeUndefined();
  });
});
