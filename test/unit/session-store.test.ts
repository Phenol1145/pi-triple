import { describe, it, expect, beforeEach } from "vitest";
import {
  registerSessionProvider, registerTraceProvider,
  listAllSessions, listAllTraces, resolveSession, resolveTrace, operateSession,
  _resetForTests,
} from "../../src/ptl/session/session-store.js";
import { uuidv7 } from "../../src/ptl/session/uuidv7.js";
import type { SessionProvider, TraceProvider } from "../../src/ptl/session/session-provider.js";

function makeProvider(workloop: string, caps: string[]): SessionProvider {
  return {
    workloop,
    capabilities: caps,
    list: () => [
      { id: "aaaaaaaa-1111-4111-8111-111111111111", kind: "session", workloop, templateId: "t1", templateAlias: "tpl-a", status: "stopped", timestamp: "2026-07-01T00:00:00.000Z", summary: `sess-${workloop}`, detail: {} },
    ],
    show: (r) => `show:${r.id}`,
    fork: (r) => ({ ok: true, message: `forked:${r.id}` }),
  };
}

describe("session-store", () => {
  beforeEach(() => {
    // 重置注册表（模块级单例，测试间隔离）
    _resetForTests();
  });

  it("session 与 trace 视图分开", () => {
    registerSessionProvider(makeProvider("pi", ["fork"]));
    registerTraceProvider({ workloop: "bidding", list: () => [{ id: "trace-1", kind: "trace", workloop: "bidding", templateId: "t1", timestamp: "x", summary: "credit -5", detail: {} }], show: () => "trace" });
    expect(listAllSessions().every((s) => s.kind === "session")).toBe(true);
    expect(listAllTraces().every((t) => t.kind === "trace")).toBe(true);
    expect(listAllSessions()).toHaveLength(1);
    expect(listAllTraces()).toHaveLength(1);
  });

  it("resolveSession 支持完整 UUID 与唯一前缀", () => {
    registerSessionProvider(makeProvider("pi", []));
    const full = resolveSession("aaaaaaaa-1111-4111-8111-111111111111");
    expect(full?.id).toBe("aaaaaaaa-1111-4111-8111-111111111111");
    const prefix = resolveSession("aaaaaaaa-1111");
    expect(prefix?.id).toBe("aaaaaaaa-1111-4111-8111-111111111111");
    expect(resolveSession("zzzz")).toBeNull();
  });

  it("operateSession 分发到 provider；capabilities 外操作返回 NOT_SUPPORTED", () => {
    const p = makeProvider("pi", ["fork"]);
    registerSessionProvider(p);
    const ok = operateSession("fork", "aaaaaaaa-1111-4111-8111-111111111111", {});
    expect(ok.ok).toBe(true);
    const no = operateSession("transfer", "aaaaaaaa-1111-4111-8111-111111111111", { templateId: "t2" });
    expect(no.ok).toBe(false);
    expect(no.error?.code).toBe("NOT_SUPPORTED");
  });

  it("operateSession 找不到会话返回 SESSION_NOT_FOUND", () => {
    registerSessionProvider(makeProvider("pi", ["fork"]));
    const r = operateSession("fork", "nope", {});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("SESSION_NOT_FOUND");
  });

  it("uuidv7 生成合法 v7 UUID（版本 7 / variant 10）", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7()).not.toBe(id);
  });
});
