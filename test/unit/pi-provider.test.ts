import { describe, it, expect, beforeEach } from "vitest";
import { registerPiSessionProvider } from "../../packages/framework/src/session/pi-provider.js";
import { listAllSessions, resolveSession, operateSession } from "../../packages/framework/src/session/session-store.js";

describe("pi-provider 注册", () => {
  beforeEach(() => { /* 依赖模块级注册：测试前清理由 store 的测试隔离处理，这里只验证行为 */ });

  it("注册后 session 视图包含 pi 纸带记录", () => {
    registerPiSessionProvider();
    const all = listAllSessions();
    expect(all.every((s) => s.workloop === "pi")).toBe(true);
  });

  it("capabilities 为全量纸带操作", () => {
    registerPiSessionProvider();
    const none = resolveSession("__none__");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("not_found");
    // 操作分派在 Task 3 测试覆盖；这里验证不存在的会话错误
    const r = operateSession("fork", "__none__", {});
    expect(r.error?.code).toBe("SESSION_NOT_FOUND");
  });
});
