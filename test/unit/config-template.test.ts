import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome: string;
beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-tpl-")); process.env.PI_TRIPLE_HOME = tmpHome; });
afterEach(() => { delete process.env.PI_TRIPLE_HOME; fs.rmSync(tmpHome, { recursive: true, force: true }); });

function writeCfg(obj: unknown) {
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(path.join(tmpHome, "pi-triple.json"), JSON.stringify(obj));
}

describe("TemplateConfig schema + V2→V3 迁移", () => {
  it("V3 配置正常加载（templates key）", async () => {
    writeCfg({ version: 3, defaultTemplate: "u1", templates: { u1: { alias: "local" } } });
    const { loadConfig } = await import("@away_from/shared");
    const cfg = loadConfig();
    expect(cfg.templates["u1"].alias).toBe("local");
    expect(cfg.defaultTemplate).toBe("u1");
  });

  it("V2 配置（tenants key）自动迁移 V3", async () => {
    writeCfg({ version: 2, defaultTenant: "u1", tenants: { u1: { alias: "local", model: "m" } } });
    const { loadConfig } = await import("@away_from/shared");
    const cfg = loadConfig();
    expect(cfg.version).toBe(3);
    expect(cfg.templates["u1"].alias).toBe("local");
    expect(cfg.templates["u1"].model).toBe("m");
    expect(cfg.defaultTemplate).toBe("u1");
    expect((cfg as any).tenants).toBeUndefined();
  });

  it("V2→V3 迁移写 .v2.bak 备份", async () => {
    writeCfg({ version: 2, defaultTenant: "u1", tenants: { u1: { alias: "x" } } });
    const { loadConfig } = await import("@away_from/shared");
    loadConfig();
    expect(fs.existsSync(path.join(tmpHome, "pi-triple.json.v2.bak"))).toBe(true);
  });

  it("V2→V3 幂等：无 tenants key 不报错", async () => {
    writeCfg({ version: 2, defaultTemplate: "u1", templates: { u1: { alias: "x" } } });
    const { loadConfig } = await import("@away_from/shared");
    const cfg = loadConfig();
    expect(cfg.version).toBe(3);
    expect(cfg.templates["u1"].alias).toBe("x");
  });

  it("createTemplate 建模板（UUID + alias）", async () => {
    writeCfg({ version: 3, defaultTemplate: "u1", templates: { u1: { alias: "local" } } });
    const { createTemplate, loadConfig } = await import("@away_from/shared");
    const id = createTemplate("dev");
    const cfg = loadConfig();
    expect(cfg.templates[id].alias).toBe("dev");
  });

  it("getTemplateAlias / resolveTemplateId 工作", async () => {
    writeCfg({ version: 3, defaultTemplate: "u1", templates: { u1: { alias: "local" } } });
    const { getTemplateAlias, resolveTemplateId } = await import("@away_from/shared");
    expect(getTemplateAlias("u1")).toBe("local");
    expect(resolveTemplateId("local").id).toBe("u1");
  });
});
