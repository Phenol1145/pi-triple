import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSessionFiles, parseSessionHeader, toSessionRecords, listNodes } from "../../src/ptl/session/pi-scan.js";
import type { PiTripleConfig } from "../../src/ptl/config.js";

// toSessionRecords 依赖 tmux 运行态：mock tmux 模块（保留 formatAge 真实实现），无真实 tmux 依赖
const tmuxMocks = vi.hoisted(() => ({
  hasTmux: vi.fn(),
  listPitSessions: vi.fn(),
  listPitPanesDetailed: vi.fn(),
}));
vi.mock("../../src/ptl/tmux.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/ptl/tmux.js")>();
  return { ...mod, hasTmux: tmuxMocks.hasTmux, listPitSessions: tmuxMocks.listPitSessions, listPitPanesDetailed: tmuxMocks.listPitPanesDetailed };
});

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

describe("toSessionRecords 状态判定（tmux mock）", () => {
  let root: string;
  beforeEach(() => {
    tmuxMocks.hasTmux.mockReset();
    tmuxMocks.listPitSessions.mockReset();
    tmuxMocks.listPitPanesDetailed.mockReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scan-records-"));
    fs.mkdirSync(path.join(root, "sessions", "t1"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "t1", "2026-07-28T16-35-58-667Z_aaaaaaaa-1111-4111-8111-111111111111.jsonl"), HEADER + "\n" + EVENT + "\n");
    process.env.PI_TRIPLE_HOME = root; // 无 pi-triple.json → aliases 兜底 templateId，测试确定
  });
  afterEach(() => {
    delete process.env.PI_TRIPLE_HOME;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("tmux 不可用 → 全部 stopped（无崩溃）", () => {
    tmuxMocks.hasTmux.mockReturnValue(false);
    const recs = toSessionRecords(scanSessionFiles(root));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe("stopped");
    expect(recs[0]!.summary).toContain("○ 停止");
  });

  it("tmux 在 + pid 存活 → running（detail 兼容：前端占用/空闲/运行命令）", () => {
    tmuxMocks.hasTmux.mockReturnValue(true);
    tmuxMocks.listPitSessions.mockReturnValue([{ name: "aaaaaaaa", windows: 1, created: new Date(), attached: 0, activityAgeMs: 5000 }]);
    tmuxMocks.listPitPanesDetailed.mockReturnValue(new Map([["pit-aaaaaaaa", { pid: process.pid, currentCommand: "pi" }]]));
    const recs = toSessionRecords(scanSessionFiles(root));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe("running");
    expect(recs[0]!.summary).toContain("● 运行中");
    expect(recs[0]!.detail["前端占用"]).toBe("0");
    expect(recs[0]!.detail["运行命令"]).toBe("pi");
  });

  it("空壳（tmux 在但 pane pid 已死）→ stopped，不再误显运行中", () => {
    tmuxMocks.hasTmux.mockReturnValue(true);
    tmuxMocks.listPitSessions.mockReturnValue([{ name: "aaaaaaaa", windows: 1, created: new Date(), attached: 0, activityAgeMs: 5000 }]);
    tmuxMocks.listPitPanesDetailed.mockReturnValue(new Map([["pit-aaaaaaaa", { pid: -1, currentCommand: "zsh" }]]));
    const recs = toSessionRecords(scanSessionFiles(root));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe("stopped");
    expect(recs[0]!.summary).toContain("○ 停止");
  });
});
