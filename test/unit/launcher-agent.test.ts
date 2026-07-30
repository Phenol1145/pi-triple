import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildPiLaunch } from "../../src/ptl/launcher.js";

describe("buildPiLaunch agent options", () => {
  let tmpHome: string;
  let templateId: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pit-agent-test-"));
    process.env.PI_TRIPLE_HOME = tmpHome;
    templateId = randomUUID();
    // minimal pi-config structure
    fs.mkdirSync(path.join(tmpHome, "data", "pi-config", templateId, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, "data", "shared", "extensions"), { recursive: true });
  });

  afterEach(() => {
    delete process.env.PI_TRIPLE_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("agentInstanceId → PI_AGENT_INSTANCE_ID env", async () => {
    const agentId = randomUUID();
    const result = await buildPiLaunch(templateId, { agentInstanceId: agentId });
    expect(result.env.PI_AGENT_INSTANCE_ID).toBe(agentId);
  });

  it("no agentInstanceId → PI_AGENT_INSTANCE_ID not set in env", async () => {
    const result = await buildPiLaunch(templateId, {});
    expect(result.env.PI_AGENT_INSTANCE_ID).toBeUndefined();
  });

  it("workspaceCwd 覆盖默认 cwd 且目录被创建", async () => {
    const customCwd = path.join(tmpHome, "custom-agent-workspace");
    const result = await buildPiLaunch(templateId, { workspaceCwd: customCwd });
    expect(result.cwd).toBe(customCwd);
    expect(fs.existsSync(customCwd)).toBe(true);
  });

  it("无 workspaceCwd 时走默认 WorkspaceManager cwd", async () => {
    const result = await buildPiLaunch(templateId, { project: "test-proj" });
    expect(result.cwd).toContain("workspaces");
    expect(result.cwd).toContain(templateId);
    expect(result.cwd).toContain("test-proj");
    expect(fs.existsSync(result.cwd)).toBe(true);
  });

  it("systemPrompt 内容→临时文件→--append-system-prompt", async () => {
    const prompt = "You are a helpful agent. Answer concisely.";
    const result = await buildPiLaunch(templateId, { systemPrompt: prompt });

    // 找 --append-system-prompt 后的文件路径
    const flagIdx = result.args.indexOf("--append-system-prompt");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    const filePath = result.args[flagIdx + 1];
    expect(filePath).toBeTruthy();
    expect(fs.existsSync(filePath!)).toBe(true);
    expect(fs.readFileSync(filePath!, "utf8")).toBe(prompt);
  });

  it("无 systemPrompt 时不加 --append-system-prompt 参数", async () => {
    const result = await buildPiLaunch(templateId, {});
    expect(result.args.includes("--append-system-prompt")).toBe(false);
  });

  it("所有新选项组合在一起工作", async () => {
    const agentId = randomUUID();
    const customCwd = path.join(tmpHome, "combo-agent");
    const prompt = "Be helpful.";
    const result = await buildPiLaunch(templateId, {
      agentInstanceId: agentId,
      workspaceCwd: customCwd,
      systemPrompt: prompt,
    });
    expect(result.env.PI_AGENT_INSTANCE_ID).toBe(agentId);
    expect(result.cwd).toBe(customCwd);
    expect(fs.existsSync(customCwd)).toBe(true);

    const flagIdx = result.args.indexOf("--append-system-prompt");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(result.args[flagIdx + 1]!)).toBe(true);
  });
});
