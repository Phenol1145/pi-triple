import { describe, it, expect, afterEach } from "vitest";
import { resolveSdkConfigPaths } from "../../packages/infra/src/sdk-paths";

const ORIG = process.env.PI_CODING_AGENT_DIR;
afterEach(() => { if (ORIG === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = ORIG; });

describe("resolveSdkConfigPaths（PTL/PTH 凭据统一）", () => {
  it("PI_CODING_AGENT_DIR 设置时指向该目录（与 PTL 同源）", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/ptl-env";
    const p = resolveSdkConfigPaths();
    expect(p.authPath).toBe("/tmp/ptl-env/auth.json");
    expect(p.modelsPath).toBe("/tmp/ptl-env/models.json");
    expect(p.modelsStorePath).toBe("/tmp/ptl-env/models-store.json");
  });

  it("未设置时返回空（SDK 回退 ~/.pi/agent）", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    expect(resolveSdkConfigPaths()).toEqual({});
  });
});
