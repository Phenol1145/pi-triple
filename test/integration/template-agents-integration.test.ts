import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execTemplateNew } from "../../packages/framework/src/commands.js";

test("launcher 启动补写 AGENTS.md（幂等）", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ptl-launch-"));
  try {
    // 构造一个最小模板目录（pi-triple.json 无实际作用——测试直接调 ensureTemplateAgents，勿加 vestigial 配置）
    const templateId = "tpl-0001";
    const tplDir = join(dataDir, "pi-config", templateId);
    mkdirSync(tplDir, { recursive: true });

    const { ensureTemplateAgents } = await import("@away_from/shared");
    const alias = "local";
    ensureTemplateAgents(tplDir, templateId, alias);
    const first = readFileSync(join(tplDir, "AGENTS.md"), "utf-8");
    assert.equal(first.includes(templateId), true);
    // 幂等：再次调用不变化
    ensureTemplateAgents(tplDir, templateId, alias);
    const second = readFileSync(join(tplDir, "AGENTS.md"), "utf-8");
    assert.equal(second, first);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("execTemplateNew 无共享层时写入 AGENTS.md 不抛 ENOENT（回归：Blocker）", async () => {
  const prevTripleHome = process.env.PI_TRIPLE_HOME;
  const prevHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "ptl-home-"));
  try {
    // fresh install 场景：共享层不存在（sharedDir 指向未创建的目录），无模块级缓存——loadConfig 每次读盘
    writeFileSync(join(home, "pi-triple.json"), JSON.stringify({
      version: 3,
      dataDir: join(home, "data"),
      sharedDir: join(home, "data", "shared"),
      redis: "redis://localhost:6379",
      gateway: { port: 3000 },
      templates: {},
    }));
    process.env.PI_TRIPLE_HOME = home;
    // migrate 源目录取 $HOME/.pi/agent——指向 tmp 使其不存在，迁移空跑不拷贝真实数据
    process.env.HOME = home;

    const alias = `regr-${Date.now().toString(36)}`;
    const result = await execTemplateNew(alias);
    assert.equal(result.ok, true);
    assert.equal(result.data?.agentsMd, true);
    assert.equal(result.data?.sharedLinked, false);

    // AGENTS.md 已生成、无占位符残留
    const templateDir = join(home, "data", "pi-config", result.data.id);
    const agentsPath = join(templateDir, "AGENTS.md");
    assert.equal(existsSync(agentsPath), true);
    const content = readFileSync(agentsPath, "utf-8");
    assert.equal(content.includes(result.data.id), true);
    assert.equal(content.includes("<templateId>"), false);
    assert.equal(content.includes("<alias>"), false);
  } finally {
    if (prevTripleHome === undefined) delete process.env.PI_TRIPLE_HOME;
    else process.env.PI_TRIPLE_HOME = prevTripleHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
