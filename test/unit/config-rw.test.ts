import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadConfig,
  createTemplate,
  getConfigValue,
  setConfigValue,
  unsetConfigValue,
} from "@away_from/shared";

describe("config get/set/unset", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-cfg-"));
    origHome = process.env.PI_TRIPLE_HOME;
    process.env.PI_TRIPLE_HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.PI_TRIPLE_HOME;
    else process.env.PI_TRIPLE_HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("get 读取顶层键", () => {
    loadConfig();  // 触发默认配置创建
    expect(getConfigValue("redis")).toBe("redis://localhost:6379");
    expect(getConfigValue("gateway.port")).toBe("3000");
    expect(getConfigValue("version")).toBe("3");
  });

  it("set redis + 持久化", () => {
    loadConfig();
    const r = setConfigValue("redis", "redis://other:6380");
    expect(r.ok).toBe(true);
    const reloaded = loadConfig();
    expect(reloaded.redis).toBe("redis://other:6380");
  });

  it("set defaultTemplate 接受别名", () => {
    const c = loadConfig();
    const localId = c.defaultTemplate;
    const newId = createTemplate("dev", {}, c);
    const r = setConfigValue("defaultTemplate", "dev");
    expect(r.ok).toBe(true);
    expect(loadConfig().defaultTemplate).toBe(newId);
    // 设回 local（别名解析）
    const r2 = setConfigValue("defaultTemplate", "local");
    expect(r2.ok).toBe(true);
    expect(loadConfig().defaultTemplate).toBe(localId);
  });

  it("set defaultTemplate 不存在的租户 → 报错", () => {
    loadConfig();
    const r = setConfigValue("defaultTemplate", "ghost");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ghost");
  });

  it("set gateway.port 校验整数范围", () => {
    loadConfig();
    expect(setConfigValue("gateway.port", "8080").ok).toBe(true);
    expect(getConfigValue("gateway.port")).toBe("8080");
    expect(setConfigValue("gateway.port", "abc").ok).toBe(false);
    expect(setConfigValue("gateway.port", "99999").ok).toBe(false);
  });

  it("templates.<alias>.model set/get/unset", () => {
    loadConfig();
    expect(setConfigValue("templates.local.model", "deepseek/deepseek-v4-pro").ok).toBe(true);
    expect(getConfigValue("templates.local.model")).toBe("deepseek/deepseek-v4-pro");
    expect(unsetConfigValue("templates.local.model").ok).toBe(true);
    expect(getConfigValue("templates.local.model")).toBeUndefined();
  });

  it("templates 字段白名单：alias 不可经 config set 修改", () => {
    loadConfig();
    const r = setConfigValue("templates.local.alias", "hacked");
    expect(r.ok).toBe(false);
  });

  it("未知键报错并列出可用键", () => {
    loadConfig();
    const r = setConfigValue("bogus.key", "x");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未知");
  });

  it("unset 顶层键拒绝", () => {
    loadConfig();
    expect(unsetConfigValue("redis").ok).toBe(false);
  });
});
