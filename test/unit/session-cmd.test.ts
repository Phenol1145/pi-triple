import { describe, it, expect } from "vitest";
import { assertResumable } from "../../packages/framework/src/commands/session.js";
import type { SessionRecord } from "../../packages/framework/src/session/session-provider.js";

const rec = (status: "running" | "stopped", workloop = "pi"): SessionRecord => ({
  id: "aaaaaaaa-1111-4111-8111-111111111111", kind: "session", workloop,
  templateId: "t1", templateAlias: "tpl-a", status, timestamp: "2026-07-01T00:00:00.000Z", summary: "", detail: {},
});

describe("assertResumable", () => {
  it("运行中的 pi 会话拒绝 resume（防双写者）", () => {
    const r = assertResumable(rec("running"));
    expect(r?.ok).toBe(false);
    expect(r?.error?.code).toBe("ALREADY_RUNNING");
  });

  it("停止的 pi 会话可 resume", () => {
    expect(assertResumable(rec("stopped"))).toBeNull();
  });

  it("非 pi 会话不支持 resume", () => {
    const r = assertResumable(rec("stopped", "machine"));
    expect(r?.ok).toBe(false);
    expect(r?.error?.code).toBe("NOT_SUPPORTED");
  });
});
