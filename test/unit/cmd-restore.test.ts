// test/unit/cmd-restore.test.ts — task 4: cmdRestore 目标解析（registry 驱动纯逻辑）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { markStarted } from "../../src/ptl/session-registry.js";
import { resolveRestoreTargets } from "../../src/ptl/pit/sessions.js";

describe("cmdRestore 目标解析", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-"));
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("无 name → 全部注册表条目；有 name → 只取指定（不存在报错）", () => {
    markStarted({ name: "a-1", templateId: "t1", startedAt: 1 }, root);
    markStarted({ name: "b-2", templateId: "t2", startedAt: 2 }, root);
    const all = resolveRestoreTargets([], root);
    expect(all.map((t) => t.name).sort()).toEqual(["a-1", "b-2"]);
    const one = resolveRestoreTargets(["a-1"], root);
    expect(one.map((t) => t.name)).toEqual(["a-1"]);
    const missing = resolveRestoreTargets(["zzz"], root);
    expect(missing).toHaveLength(0);
  });
});
