import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSessionFiles, parseSessionHeader, toSessionRecords, listNodes, isTapeLive, newestTapeId, pickRestoreTape } from "../../packages/framework/src/session/pi-scan.js";
import type { PiTripleConfig } from "@pi-triple/shared";

// toSessionRecords 依赖 tmux 运行态：mock tmux 模块（保留 formatAge 真实实现），无真实 tmux 依赖
const tmuxMocks = vi.hoisted(() => ({
  hasTmux: vi.fn(),
  listPtlSessions: vi.fn().mockReturnValue([]),
  listPtlPanesDetailed: vi.fn().mockReturnValue(new Map()),
}));
// toSessionRecords 走 SessionBackend（tmux-backend 内部从 ./tmux.js import）——
// mock tmux.js 文件本身（shared/index 的 re-export 与 tmux-backend 的相对 import 共享同一文件）
vi.mock("../../packages/shared/src/tmux.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../packages/shared/src/tmux.js")>();
  return { ...mod, hasTmux: tmuxMocks.hasTmux, listPtlSessions: tmuxMocks.listPtlSessions, listPtlPanesDetailed: tmuxMocks.listPtlPanesDetailed };
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

  it("newestTapeId：since 窗口内最新 mtime 纸带", () => {
    const now = Date.now();
    const w2 = path.join(root, "sessions", "t1", "old.jsonl");
    const w3 = path.join(root, "sessions", "t1", "new.jsonl");
    fs.writeFileSync(w2, `{"type":"session","version":3,"id":"old","timestamp":"2026-07-28T00:00:00.000Z","cwd":"/w"}\n`);
    fs.writeFileSync(w3, `{"type":"session","version":3,"id":"new","timestamp":"2026-07-28T00:00:00.000Z","cwd":"/w"}\n`);
    const old = fs.statSync(w2); fs.utimesSync(w2, old.atime, new Date(now - 60_000));
    const files = scanSessionFiles(root);
    expect(newestTapeId("t1", now - 10_000, files)).toBe("new");
    expect(newestTapeId("t1", now + 10_000, files)).toBeUndefined();
  });

  it("pickRestoreTape：sessionId 优先；文件已消失回退模板最新", () => {
    const now = Date.now();
    fs.writeFileSync(path.join(root, "sessions", "t1", "x.jsonl"), `{"type":"session","version":3,"id":"aaaa","timestamp":"2026-07-28T00:00:00.000Z","cwd":"/w"}\n`);
    const files = scanSessionFiles(root);
    expect(pickRestoreTape(files, { templateId: "t1", sessionId: "aaaa" }, () => false).resumeSession).toBe("aaaa");
    // sessionId 文件不存在 → 回退最新
    expect(pickRestoreTape(files, { templateId: "t1", sessionId: "gone" }, () => false).resumeSession).toBe("aaaa");
  });

  it("pickRestoreTape：纸带正被其他会话使用 → 警告且不 resume", () => {
    fs.writeFileSync(path.join(root, "sessions", "t1", "x.jsonl"), `{"type":"session","version":3,"id":"aaaa","timestamp":"2026-07-28T00:00:00.000Z","cwd":"/w"}\n`);
    const files = scanSessionFiles(root);
    const r = pickRestoreTape(files, { templateId: "t1", sessionId: "aaaa" }, () => true);
    expect(r.resumeSession).toBeUndefined();
    expect(r.warning).toBeTruthy();
  });

  it("isTapeLive：pane 名 ptl-<id8> 或 currentCommand 含完整 id", async () => {
    const panes = new Map<string, any>([
      ["ptl-aaaaaaaa", { pid: 123, currentCommand: "pi --session aaaaaaaa-1111-4111-8111-111111111111" }],
    ]);
    expect(await isTapeLive("aaaaaaaa-1111-4111-8111-111111111111", panes)).toBe(true);
    expect(await isTapeLive("bbbbbbbb-2222-4222-8222-222222222222", panes)).toBe(false);
  });
});

describe("toSessionRecords 状态判定（tmux mock）", () => {
  let root: string;
  beforeEach(() => {
    tmuxMocks.hasTmux.mockReset();
    tmuxMocks.listPtlSessions.mockReset().mockReturnValue([]);
    tmuxMocks.listPtlPanesDetailed.mockReset().mockReturnValue(new Map());
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scan-records-"));
    fs.mkdirSync(path.join(root, "sessions", "t1"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "t1", "2026-07-28T16-35-58-667Z_aaaaaaaa-1111-4111-8111-111111111111.jsonl"), HEADER + "\n" + EVENT + "\n");
    process.env.PI_TRIPLE_HOME = root; // 无 pi-triple.json → aliases 兜底 templateId，测试确定
  });
  afterEach(() => {
    delete process.env.PI_TRIPLE_HOME;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("tmux 不可用 → 全部 stopped（无崩溃）", async () => {
    tmuxMocks.hasTmux.mockReturnValue(false);
    const recs = await toSessionRecords(scanSessionFiles(root));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe("stopped");
    expect(recs[0]!.summary).toContain("○ 停止");
  });

  it("tmux 在 + pid 存活 → running（detail 兼容：前端占用/空闲/运行命令）", async () => {
    tmuxMocks.hasTmux.mockReturnValue(true);
    tmuxMocks.listPtlSessions.mockReturnValue([{ name: "aaaaaaaa", windows: 1, created: new Date(), attached: 0, activityAgeMs: 5000 }]);
    tmuxMocks.listPtlPanesDetailed.mockReturnValue(new Map([["ptl-aaaaaaaa", { pid: process.pid, currentCommand: "pi" }]]));
    const recs = await toSessionRecords(scanSessionFiles(root));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe("running");
    expect(recs[0]!.summary).toContain("● 运行中");
    expect(recs[0]!.detail["前端占用"]).toBe("0");
    expect(recs[0]!.detail["运行命令"]).toBe("pi");
  });

  it("空壳（tmux 在但 pane pid 已死）→ stopped，不再误显运行中", async () => {
    tmuxMocks.hasTmux.mockReturnValue(true);
    tmuxMocks.listPtlSessions.mockReturnValue([{ name: "aaaaaaaa", windows: 1, created: new Date(), attached: 0, activityAgeMs: 5000 }]);
    tmuxMocks.listPtlPanesDetailed.mockReturnValue(new Map([["ptl-aaaaaaaa", { pid: -1, currentCommand: "zsh" }]]));
    const recs = await toSessionRecords(scanSessionFiles(root));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe("stopped");
    expect(recs[0]!.summary).toContain("○ 停止");
  });
});
