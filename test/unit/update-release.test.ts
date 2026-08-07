import { describe, it, expect } from "vitest";
import { buildAssetUrl, parseLatestRelease, parseSha256File, verifySha256 } from "../../packages/framework/src/cli/admin.js";

describe("buildAssetUrl", () => {
  it("构造下载 URL", () => {
    expect(buildAssetUrl("v0.2.0", "0.2.0"))
      .toBe("https://github.com/Phenol1145/pi-triple/releases/download/v0.2.0/pi-triple-0.2.0.tgz");
  });
});

describe("parseLatestRelease", () => {
  it("解析 tag/assets（含 .sha256 附件）", () => {
    const parsed = parseLatestRelease({
      tag_name: "v0.2.0",
      assets: [
        { name: "pi-triple-0.1.0.tgz" },
        { name: "pi-triple-0.2.0.tgz" },
        { name: "pi-triple-0.2.0.sha256" },
      ],
    });
    expect(parsed).toEqual({
      tag: "v0.2.0",
      version: "0.2.0",
      assetName: "pi-triple-0.2.0.tgz",
      digestAssetName: "pi-triple-0.2.0.sha256",
    });
  });
  it("无 .sha256 附件 → digestAssetName undefined（兼容旧 release）", () => {
    expect(parseLatestRelease({ tag_name: "v0.2.0", assets: [{ name: "pi-triple-0.2.0.tgz" }] }))
      .toEqual({ tag: "v0.2.0", version: "0.2.0", assetName: "pi-triple-0.2.0.tgz", digestAssetName: undefined });
  });
  it("无匹配 tarball asset → undefined", () => {
    expect(parseLatestRelease({ tag_name: "v0.2.0", assets: [] })).toBeUndefined();
    expect(parseLatestRelease({})).toBeUndefined();
  });
});

describe("parseSha256File", () => {
  it("shasum 标准输出格式（hex + 双空格 + 文件名）", () => {
    const digest = "a".repeat(64);
    expect(parseSha256File(`${digest}  pi-triple-0.2.0.tgz`)).toBe(digest);
  });
  it("裸 hex / 多行取第一个 token / 大小写归一", () => {
    const digest = "b".repeat(64);
    expect(parseSha256File(`${digest}\n`)).toBe(digest);
    expect(parseSha256File(`${digest}  pi-triple-0.2.0.tgz\n${"c".repeat(64)}  other.tgz`)).toBe(digest);
    expect(parseSha256File("A".repeat(64))).toBe("a".repeat(64));
  });
  it("异常内容 → undefined", () => {
    expect(parseSha256File("")).toBeUndefined();
    expect(parseSha256File("   ")).toBeUndefined();
    expect(parseSha256File("abc")).toBeUndefined();
    expect(parseSha256File("not-a-hex-token  pi-triple-0.2.0.tgz")).toBeUndefined();
    expect(parseSha256File(`${"a".repeat(63)}  pi-triple-0.2.0.tgz`)).toBeUndefined();
  });
});

describe("verifySha256", () => {
  it("相等 true，不等 false", () => {
    expect(verifySha256("abc", "abc")).toBe(true);
    expect(verifySha256("abc", "abd")).toBe(false);
  });
});
