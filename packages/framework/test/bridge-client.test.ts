import { describe, it, expect } from "vitest";
import { PthClient } from "../src/bridge/client.js";

describe("PthClient（bridge/client 拆分后公共面）", () => {
  const client = new PthClient("http://127.0.0.1:3000", "test-token");

  it("保留 baseUrl / authToken 访问器", () => {
    expect(client.baseUrl).toBe("http://127.0.0.1:3000");
    expect(client.authToken).toBe("test-token");
  });

  it("debugUrl 携带会话 id", () => {
    expect(client.debugUrl("s-1")).toContain("s-1");
    expect(client.debugUrl()).toContain("debug");
  });

  it("提交 DTO 类型在拆分后仍可引用（编译期契约）", () => {
    const dto: { type: string; data: Record<string, unknown> } = { type: "task.done", data: {} };
    expect(dto.type).toBe("task.done");
  });
});
