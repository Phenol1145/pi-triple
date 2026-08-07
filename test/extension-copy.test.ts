// extension/skill copy 双模式（spec §6.2 遮蔽机制）：
// - 引用模式（默认）：环境 extensions/ 下建 symlink → shared/extensions/<name>（共享，一处修改处处生效）
// - 源码模式（--mode 源码/source）：复制实体到环境 extensions/<name>（遮蔽共享 symlink，独立可改）
// - skill 同机制（shared/skills → 环境 skills/）
// - 完成后提示会话内 /reload 生效（spec §5）
// 适配说明（相对 brief 示例）：brief 只给了 2 个 extension 测试；本文件补 skill 双模式 +
// 源码覆盖已有 symlink（先 unlink 再 cp）+ 引用覆盖已有实体（保守报错不删用户数据）+
// dispatch 注册集成测试，覆盖完整产出接口（execExtensionCopy/execSkillCopy）。
// 数据隔离同 test/env.test.ts（PI_TRIPLE_HOME + HOME → tmpdir）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execExtensionCopy, execSkillCopy } from "../packages/framework/src/extension-copy.js";
import { loadConfig, saveConfig, resolveDataDir } from "@pi-triple/shared";
import { dispatchCommand } from "../packages/framework/src/commands/dispatch.js";

describe("extension/skill copy 双模式", () => {
  let dir: string;
  let prevHome: string | undefined;
  let prevTripleHome: string | undefined;
  let envDir: string;
  let sharedDir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ptl-ext-copy-"));
    prevTripleHome = process.env.PI_TRIPLE_HOME;
    process.env.PI_TRIPLE_HOME = dir;
    prevHome = process.env.HOME;
    process.env.HOME = dir;

    // 配置：单模板 env1（默认）；dataDir=tmp/data，sharedDir=tmp/data/shared
    const cfg = loadConfig();
    const id = randomUUID();
    cfg.defaultTemplate = id;
    cfg.templates = { [id]: { alias: "env1" } };
    saveConfig(cfg);

    const dataDir = resolveDataDir(cfg);
    sharedDir = join(dataDir, "shared");
    envDir = join(dataDir, "pi-config", id);

    // 共享层实体：extensions/e1、e2；skills/s1、s2
    for (const [kind, names] of [["extensions", ["e1", "e2"]], ["skills", ["s1", "s2"]]] as const) {
      for (const n of names) {
        await mkdir(join(sharedDir, kind, n), { recursive: true });
        await writeFile(join(sharedDir, kind, n, kind === "skills" ? "SKILL.md" : "index.js"), `// ${n}\n`);
      }
    }

    // 环境目录（extensions/skills 子目录，无条目）
    await mkdir(join(envDir, "extensions"), { recursive: true });
    await mkdir(join(envDir, "skills"), { recursive: true });
  });

  afterAll(async () => {
    if (prevTripleHome === undefined) delete process.env.PI_TRIPLE_HOME;
    else process.env.PI_TRIPLE_HOME = prevTripleHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  });

  it("reference mode creates symlink (extension) + /reload 提示", async () => {
    const r = await execExtensionCopy("e1", { from: "env1", mode: "reference" });
    expect(r.ok).toBe(true);
    const link = join(envDir, "extensions", "e1");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(r.message).toContain("/reload");
  });

  it("source mode copies entity (shadows symlink) (extension)", async () => {
    const r = await execExtensionCopy("e2", { from: "env1", mode: "source" });
    expect(r.ok).toBe(true);
    const d = join(envDir, "extensions", "e2");
    expect((await lstat(d)).isDirectory()).toBe(true);
    expect((await lstat(d)).isSymbolicLink()).toBe(false);
  });

  it("skill reference mode (default mode) creates symlink", async () => {
    const r = await execSkillCopy("s1", { from: "env1" });
    expect(r.ok).toBe(true);
    const link = join(envDir, "skills", "s1");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("skill source mode copies entity", async () => {
    const r = await execSkillCopy("s2", { from: "env1", mode: "source" });
    expect(r.ok).toBe(true);
    const d = join(envDir, "skills", "s2");
    expect((await lstat(d)).isDirectory()).toBe(true);
    expect((await lstat(d)).isSymbolicLink()).toBe(false);
  });

  it("source mode over existing symlink unlinks first (中文 mode 值归一化)", async () => {
    // e1 已被引用为 symlink → 源码模式应先 unlink 再 cp 成实体
    const r = await execExtensionCopy("e1", { from: "env1", mode: "源码" });
    expect(r.ok).toBe(true);
    const d = join(envDir, "extensions", "e1");
    expect((await lstat(d)).isSymbolicLink()).toBe(false);
    expect((await lstat(d)).isDirectory()).toBe(true);
  });

  it("reference mode over existing entity errors (不删用户实体)", async () => {
    const r = await execExtensionCopy("e2", { from: "env1", mode: "reference" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("EXISTS");
    // 实体保留
    expect((await lstat(join(envDir, "extensions", "e2"))).isDirectory()).toBe(true);
  });

  it("dispatch: env extension-copy --from --mode 注册（CLI 通路）", async () => {
    // e2 是实体（上一条已验证引用模式报 EXISTS）→ 参数正确路由则报 EXISTS；未注册则 UNKNOWN_COMMAND
    const r = await dispatchCommand("env", ["extension-copy", "e2", "--from", "env1", "--mode", "引用"]);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("EXISTS");
  });

  it("dispatch: env skill-copy --from --mode 注册", async () => {
    const r = await dispatchCommand("env", ["skill-copy", "s2", "--from", "env1", "--mode", "源码"]);
    expect(r.ok).toBe(true);
  });
});
