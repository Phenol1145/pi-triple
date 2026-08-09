import { describe, it, expect } from "vitest";
import { getSessionBackend } from "../../packages/shared/src/session-backend.js";
import { createTmuxBackend } from "../../packages/shared/src/tmux-backend.js";

/** SessionBackend 契约（tmux 实现——会话服务抽象核心） */
describe("SessionBackend（tmux 实现——会话服务抽象）", () => {
  it("tmux backend 全原语存在（接口契约）", () => {
    const b = createTmuxBackend();
    for (const m of ["available", "configure", "sessionName", "validateName", "has", "create", "attach", "switchTo", "detach", "kill", "list", "panes", "panesDetailed", "panePid", "sendKeys", "sessionsForTenant", "hintText", "formatAge"]) {
      expect(typeof (b as unknown as Record<string, unknown>)[m]).toBe("function");
    }
  });

  it("前缀规则收敛进实现（ptl- 是 tmux 细节）", () => {
    const b = createTmuxBackend();
    expect(b.sessionName("coding")).toBe("ptl-coding");
    expect(b.kind).toBe("tmux");
  });

  it("hintText 是复用器特定提示（tmux Ctrl+B 体系）", () => {
    expect(createTmuxBackend().hintText()).toContain("Ctrl+B");
  });

  it("getSessionBackend 工厂（缺省 tmux）", async () => {
    const b = await getSessionBackend();
    expect(b.kind).toBe("tmux");
  });

  it("zellij/screen 为扩展点（明确错误）", async () => {
    await expect(getSessionBackend("zellij")).rejects.toThrow(/尚未实现/);
    await expect(getSessionBackend("screen")).rejects.toThrow(/尚未实现/);
  });

  it("validateName 消毒复用（合法 null / 非法消息）", () => {
    const b = createTmuxBackend();
    expect(b.validateName("my-session_1.x")).toBeNull();
    expect(b.validateName("bad name!")).toMatch(/非法/);
  });
});
