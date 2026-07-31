import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSessionFiles, parseSessionHeader, toSessionRecords, listNodes } from "../../src/ptl/session/pi-scan.js";
import type { PiTripleConfig } from "../../src/ptl/config.js";

const HEADER = '{"type":"session","version":3,"id":"aaaaaaaa-1111-4111-8111-111111111111","timestamp":"2026-07-28T16:35:58.667Z","cwd":"/tmp/w1","parentSession":"/tmp/w0/source.jsonl"}';
const EVENT = '{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-07-28T16:36:00.000Z","message":{"role":"user","content":"hi"}}';

function makeConfig(root: string): PiTripleConfig {
  return { version: 3, defaultTemplate: "t1", dataDir: root, sharedDir: path.join(root, "shared"), redis: "localhost:6379", gateway: { port: 1 }, templates: { t1: { alias: "tpl-a" } } } as PiTripleConfig;
}

describe("pi-scan", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scan-"));
    fs.mkdirSync(path.join(root, "sessions", "t1"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "t1", "2026-07-28T16-35-58-667Z_aaaaaaaa-1111-4111-8111-111111111111.jsonl"), HEADER + "\n" + EVENT + "\n");
    fs.mkdirSync(path.join(root, "sessions", "t2"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "t2", "2026-07-29T00-00-00-000Z_bbbbbbbb-2222-4222-8222-222222222222.jsonl"), '{"type":"session","version":3,"id":"bbbbbbbb-2222-4222-8222-222222222222","timestamp":"2026-07-29T00:00:00.000Z","cwd":"/tmp/w2"}\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("扫描跨模板会话文件并解析 header", () => {
    const files = scanSessionFiles(root);
    expect(files).toHaveLength(2);
    const a = files.find((f) => f.id === "aaaaaaaa-1111-4111-8111-111111111111")!;
    expect(a.templateId).toBe("t1");
    expect(a.parentSession).toBe("/tmp/w0/source.jsonl");
    expect(a.lineCount).toBe(2);
  });

  it("parseSessionHeader 容忍坏行返回 null", () => {
    expect(parseSessionHeader("not json")).toBeNull();
    expect(parseSessionHeader('{"type":"message","id":"x"}')).toBeNull();
    expect(parseSessionHeader(HEADER)?.id).toBe("aaaaaaaa-1111-4111-8111-111111111111");
  });

  it("listNodes 按时间序返回事件摘要", () => {
    const file = scanSessionFiles(root).find((f) => f.id.startsWith("aaaaaaaa"))!;
    const nodes = listNodes(file.file);
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0]!.id).toBe("a1b2c3d4");
    expect(nodes[0]!.summary).toContain("user");
  });
});
