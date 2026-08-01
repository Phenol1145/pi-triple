import { describe, it, expect } from "vitest";
import { buildAssetUrl, parseLatestRelease, verifySha256 } from "../../src/ptl/pit/admin.js";

describe("buildAssetUrl", () => {
  it("构造下载 URL", () => {
    expect(buildAssetUrl("v0.2.0", "0.2.0"))
      .toBe("https://github.com/Phenol1145/pi-triple/releases/download/v0.2.0/pi-triple-0.2.0.tgz");
  });
});

describe("parseLatestRelease", () => {
  it("解析 tag/assets（含 digest）", () => {
    const parsed = parseLatestRelease({
      tag_name: "v0.2.0",
      assets: [
        { name: "pi-triple-0.1.0.tgz", digest: "sha256:abc" },
        { name: "pi-triple-0.2.0.tgz", digest: "sha256:def" },
      ],
    });
    expect(parsed).toEqual({ tag: "v0.2.0", version: "0.2.0", assetName: "pi-triple-0.2.0.tgz", digest: "def" });
  });
  it("无匹配 asset → undefined", () => {
    expect(parseLatestRelease({ tag_name: "v0.2.0", assets: [] })).toBeUndefined();
    expect(parseLatestRelease({})).toBeUndefined();
  });
});

describe("verifySha256", () => {
  it("相等 true，不等 false", () => {
    expect(verifySha256("abc", "abc")).toBe(true);
    expect(verifySha256("abc", "abd")).toBe(false);
  });
});
