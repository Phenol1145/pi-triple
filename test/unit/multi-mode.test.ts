import { describe, it, expect, vi, beforeEach } from "vitest";
import { emitJson, emitJsonError, ERR } from "@pi-triple/shared";
import {
  execTemplateLs,
  execTemplateRm,
  execTemplateNew,
  execStop,
  execLs,
  execStatus,
  execSharedStatus,
  type CommandResult,
} from "../../packages/framework/src/commands.js";

// ─── output.ts ───────────────────────────────────────────────

describe("emitJson", () => {
  let logs: any[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args[0]);
    });
  });

  it("outputs correct envelope with data", () => {
    emitJson({ tenants: [{ id: "a", alias: "x" }] });
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ tenants: [{ id: "a", alias: "x" }] });
    expect(parsed.error).toBeNull();
  });

  it("handles null data", () => {
    emitJson(null);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toBeNull();
  });

  it("handles empty object data", () => {
    emitJson({});
    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({});
  });
});

describe("emitJsonError", () => {
  let logs: any[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args[0]);
    });
  });

  it("outputs error envelope", () => {
    emitJsonError(ERR.TENANT_NOT_FOUND, "租户不存在");
    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toEqual({ code: "TENANT_NOT_FOUND", message: "租户不存在" });
  });

  it("includes candidates for ambiguous errors", () => {
    emitJsonError(ERR.TENANT_AMBIGUOUS, "匹配多个", ["abc-1", "abc-2"]);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.error.candidates).toEqual(["abc-1", "abc-2"]);
  });

  it("omits candidates field when not provided", () => {
    emitJsonError(ERR.SESSION_NOT_FOUND, "不存在");
    const parsed = JSON.parse(logs[0]);
    expect(parsed.error).not.toHaveProperty("candidates");
  });
});

describe("ERR constants", () => {
  it("has all expected error codes", () => {
    expect(ERR.TENANT_NOT_FOUND).toBe("TENANT_NOT_FOUND");
    expect(ERR.TENANT_AMBIGUOUS).toBe("TENANT_AMBIGUOUS");
    expect(ERR.SESSION_NOT_FOUND).toBe("SESSION_NOT_FOUND");
    expect(ERR.TMUX_NOT_INSTALLED).toBe("TMUX_NOT_INSTALLED");
    expect(ERR.CONFIG_PARSE_ERROR).toBe("CONFIG_PARSE_ERROR");
    expect(ERR.INTERACTIVE_REQUIRED).toBe("INTERACTIVE_REQUIRED");
    expect(ERR.TUI_NO_JSON).toBe("TUI_NO_JSON");
    expect(ERR.UNKNOWN_COMMAND).toBe("UNKNOWN_COMMAND");
    expect(ERR.HANDOFF_REQUIRED).toBe("HANDOFF_REQUIRED");
  });
});

// ─── commands.ts — structural checks ─────────────────────────

describe("execTemplateLs", () => {
  it("returns ok with tenants array in data", async () => {
    const result = await execTemplateLs();
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data.templates).toBeDefined();
    expect(Array.isArray(result.data.templates)).toBe(true);
    if (result.data.templates.length > 0) {
      const t = result.data.templates[0];
      expect(t).toHaveProperty("id");
      expect(t).toHaveProperty("alias");
      expect(t).toHaveProperty("isDefault");
      expect(t).toHaveProperty("model");
      expect(t).toHaveProperty("extensions");
      expect(t).toHaveProperty("skills");
    }
  });

  it("returns string message", async () => {
    const result = await execTemplateLs();
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("execTemplateRm", () => {
  it("rejects empty input", async () => {
    const result = await execTemplateRm("");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(ERR.INTERACTIVE_REQUIRED);
  });

  it("rejects nonexistent tenant", async () => {
    const result = await execTemplateRm("nonexistent-uuid-12345678");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(ERR.TENANT_NOT_FOUND);
  });
});

describe("execTemplateNew", () => {
  it("rejects empty alias", async () => {
    const result = await execTemplateNew("");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(ERR.INTERACTIVE_REQUIRED);
  });

  it("rejects undefined alias", async () => {
    const result = await execTemplateNew(undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(ERR.INTERACTIVE_REQUIRED);
  });
});

describe("execStop", () => {
  it("rejects empty name", async () => {
    const result = await execStop("");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(ERR.INTERACTIVE_REQUIRED);
  });
});

describe("execLs", () => {
  it("returns ok with sessions array", async () => {
    const result = await execLs();
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data.sessions).toBeDefined();
    expect(Array.isArray(result.data.sessions)).toBe(true);
  });
});

describe("execStatus", () => {
  it("returns ok with allOk boolean and checks array", async () => {
    const result = await execStatus();
    // status can be ok:true or ok:false depending on environment
    expect(typeof result.ok).toBe("boolean");
    expect(result.data).toBeDefined();
    expect(typeof result.data.allOk).toBe("boolean");
    expect(Array.isArray(result.data.checks)).toBe(true);
    expect(result.data.checks.length).toBeGreaterThan(0);
    for (const c of result.data.checks) {
      expect(c).toHaveProperty("name");
      expect(c).toHaveProperty("ok");
      expect(c).toHaveProperty("message");
    }
  });
});

describe("execSharedStatus", () => {
  it("returns ok with exists boolean", async () => {
    const result = await execSharedStatus();
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(typeof result.data.exists).toBe("boolean");
  });
});
