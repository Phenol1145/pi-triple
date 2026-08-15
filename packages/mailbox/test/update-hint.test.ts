import { describe, it, expect, vi } from "vitest";
import { formatUpdateHint, maybeShowUpdateHint } from "@away_from/mailbox";

describe("formatUpdateHint", () => {
  it("ptl 有更新 → 提示行", () => {
    const lines = formatUpdateHint({ pit: "0.2.0", currentPit: "0.1.0" });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("ptl 更新可用: v0.2.0（当前 v0.1.0）");
    expect(lines[0]).toContain("ptl update");
  });
  it("pi SDK 有更新 → 提示行", () => {
    const lines = formatUpdateHint({ piSdk: "0.84.0", currentPiSdk: "0.83.0" });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("pi SDK 更新可用: v0.84.0");
  });
  it("无更新 → 空数组", () => {
    expect(formatUpdateHint({ pit: "0.1.0", currentPit: "0.1.0" })).toEqual([]);
    expect(formatUpdateHint({})).toEqual([]);
    expect(formatUpdateHint({ pit: "0.2.0" })).toEqual([]); // 无当前版本无法判断
  });
});

describe("maybeShowUpdateHint", () => {
  it("checker 返回更新 → notify 每行 + warning 级别", async () => {
    const notify = vi.fn();
    const ctx = { ui: { notify } };
    const checker = vi.fn(async () => ({ pit: "0.2.0", currentPit: "0.1.0", piSdk: "0.84.0", currentPiSdk: "0.83.0" }));
    await maybeShowUpdateHint(ctx as never, { checker: checker as never });
    expect(checker).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, expect.stringContaining("ptl 更新可用"), "warning");
    expect(notify).toHaveBeenNthCalledWith(2, expect.stringContaining("pi SDK 更新可用"), "warning");
  });

  it("checker 返回无更新 → 不 notify", async () => {
    const notify = vi.fn();
    const ctx = { ui: { notify } };
    const checker = vi.fn(async () => ({}));
    await maybeShowUpdateHint(ctx as never, { checker: checker as never });
    expect(notify).not.toHaveBeenCalled();
  });

  it("checker 抛异常 → 静默（不抛出、不 notify）", async () => {
    const notify = vi.fn();
    const ctx = { ui: { notify } };
    const checker = vi.fn(async () => { throw new Error("network down"); });
    await expect(maybeShowUpdateHint(ctx as never, { checker: checker as never })).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("notify 抛异常 → 静默（不抛出）", async () => {
    const notify = vi.fn(() => { throw new Error("ui broken"); });
    const ctx = { ui: { notify } };
    const checker = vi.fn(async () => ({ pit: "0.2.0", currentPit: "0.1.0" }));
    await expect(maybeShowUpdateHint(ctx as never, { checker: checker as never })).resolves.toBeUndefined();
  });
});
