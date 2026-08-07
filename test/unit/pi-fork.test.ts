import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSessionFiles } from "../../packages/framework/src/session/pi-scan.js";
import { forkSession, cloneSession, transferSession, forkSessionAtNode } from "../../packages/framework/src/session/pi-fork.js";

const H1 = '{"type":"session","version":3,"id":"aaaaaaaa-1111-4111-8111-111111111111","timestamp":"2026-07-28T16:35:58.667Z","cwd":"/w/t1"}';
const E1 = '{"type":"message","id":"e1","parentId":null,"timestamp":"2026-07-28T16:36:00.000Z","message":{"role":"user","content":"root"}}';
const E2 = '{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-07-28T16:36:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"reply"}]}}';
const E3 = '{"type":"message","id":"e3","parentId":"e2","timestamp":"2026-07-28T16:36:02.000Z","message":{"role":"user","content":"next"}}';
const E4 = '{"type":"message","id":"e4","parentId":"e2","timestamp":"2026-07-28T16:36:03.000Z","message":{"role":"user","content":"branch-child"}}';
const LABEL = '{"type":"label","id":"e5","parentId":"e2","timestamp":"2026-07-28T16:36:04.000Z","targetId":"e1","label":"checkpoint"}';
const COMPACTION = '{"type":"compaction","id":"e6","parentId":"e1","timestamp":"2026-07-28T16:36:05.000Z","summary":"sum","firstKeptEntryId":"e2","tokensBefore":100}';
const E6 = COMPACTION;

describe("pi-fork", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-"));
    fs.mkdirSync(path.join(root, "sessions", "t1"), { recursive: true });
    fs.mkdirSync(path.join(root, "sessions", "t2"), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function writeSession(name: string, lines: string[]): string {
    const file = path.join(root, "sessions", "t1", name);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  it("fork 写 parentSession + 复制全部事件", () => {
    writeSession("a.jsonl", [H1, E1, E2]);
    const src = scanSessionFiles(root)[0]!;
    const r = forkSession(src, {});
    expect(r.ok).toBe(true);
    const newFile = (r.data as { file: string }).file;
    const content = fs.readFileSync(newFile, "utf-8").trim().split("\n");
    const h = JSON.parse(content[0]!) as any;
    expect(h.parentSession).toBe(src.file);
    expect(h.id).not.toBe(src.id);
    expect(content).toHaveLength(3); // header + 2 事件
  });

  it("clone 对齐官方 /clone：同样写 parentSession", () => {
    writeSession("a.jsonl", [H1, E1]);
    const src = scanSessionFiles(root)[0]!;
    const r = cloneSession(src, {});
    expect(r.ok).toBe(true);
    const h = JSON.parse(fs.readFileSync((r.data as { file: string }).file, "utf-8").split("\n")[0]!) as any;
    expect(h.parentSession).toBe(src.file);
  });

  it("fork 指定目标模板时 cwd 更新为目标模板 workspace", () => {
    writeSession("a.jsonl", [H1, E1]);
    const src = scanSessionFiles(root)[0]!;
    const r = forkSession(src, { templateId: "t2" });
    expect(r.ok).toBe(true);
    const h = JSON.parse(fs.readFileSync((r.data as { file: string }).file, "utf-8").split("\n")[0]!) as any;
    expect(h.cwd).toContain("t2");
  });

  it("transfer 更新 cwd + 保留 parentSession + 删源", () => {
    writeSession("a.jsonl", [H1, E1, E2]);
    const src = scanSessionFiles(root)[0]!;
    const r = transferSession(src, { templateId: "t2" });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(src.file)).toBe(false); // 源已删
    const files = fs.readdirSync(path.join(root, "sessions", "t2"));
    expect(files).toHaveLength(1);
    const h = JSON.parse(fs.readFileSync(path.join(root, "sessions", "t2", files[0]!), "utf-8").split("\n")[0]!) as any;
    expect(h.cwd).toContain("t2");
    expect(h.id).toBe(src.id);
  });

  it("transfer 目标不存在返回 TEMPLATE_NOT_FOUND；目标已存在同 id 返回 ALREADY_EXISTS", () => {
    writeSession("a.jsonl", [H1, E1]);
    const src = scanSessionFiles(root)[0]!;
    const r1 = transferSession(src, { templateId: "nope" });
    expect(r1.error?.code).toBe("TEMPLATE_NOT_FOUND");
    fs.mkdirSync(path.join(root, "sessions", "t2"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "t2", "dup.jsonl"), H1 + "\n");
    // 同 id 目标已存在 → 拒绝
    const r2 = transferSession(src, { templateId: "t2" });
    expect(r2.error?.code).toBe("ALREADY_EXISTS");
  });

  it("branch 收集 root→node 主线：不含 node 后代，label 重链 + 重建", () => {
    writeSession("a.jsonl", [H1, E1, E2, E3, E4, LABEL]);
    const src = scanSessionFiles(root)[0]!;
    // node = e3（主线 e1→e2→e3）；e4 是 e2 的分支后代，label e5 挂在 e2 下
    const r = forkSessionAtNode(src, { at: "e3" });
    expect(r.ok).toBe(true);
    const content = fs.readFileSync((r.data as { file: string }).file, "utf-8").trim().split("\n");
    const entries = content.slice(1).map((l) => JSON.parse(l) as any);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain("e1");
    expect(ids).toContain("e2");
    expect(ids).toContain("e3");
    expect(ids).not.toContain("e4"); // 分支后代不复制
    expect(ids).not.toContain("e5"); // label 重链：不保留原 label 行
    // 重建 label：targetId=e1 的 label 应存在（挂在新链上）
    const rebuilt = entries.find((e) => e.type === "label");
    expect(rebuilt?.targetId).toBe("e1");
    expect(rebuilt?.parentId).toBe("e3"); // 重链到主线末端
    // parentId 链连续：e1 的 parentId 为 null
    expect(entries.find((e) => e.id === "e1")?.parentId).toBeNull();
  });

  it("branch 节点不存在返回 NODE_NOT_FOUND；孤儿节点主线 = 可回溯部分", () => {
    writeSession("a.jsonl", [H1, E1, E2]);
    const src = scanSessionFiles(root)[0]!;
    expect(forkSessionAtNode(src, { at: "zzz" }).error?.code).toBe("NODE_NOT_FOUND");
  });

  it("fork 容忍纸带损坏行：跳过坏行、其余事件照常复制", () => {
    writeSession("a.jsonl", [H1, E1, "this-is-not-json{{{", E2]);
    const src = scanSessionFiles(root)[0]!;
    const r = forkSession(src, {});
    expect(r.ok).toBe(true);
    const content = fs.readFileSync((r.data as { file: string }).file, "utf-8").trim().split("\n");
    const ids = content.slice(1).map((l) => JSON.parse(l) as any).map((e) => e.id);
    expect(ids).toEqual(["e1", "e2"]);
  });

  it("fork 容错消息：1 行坏数据 → message 含（跳过 1 行损坏数据）", () => {
    writeSession("a.jsonl", [H1, E1, "this-is-not-json{{{", E2]);
    const src = scanSessionFiles(root)[0]!;
    const r = forkSession(src, {});
    expect(r.ok).toBe(true);
    expect(r.message).toContain("（跳过 1 行损坏数据）");
  });

  it("clone 容错消息：2 行坏数据 → skipped 计数准确（跳过 2 行）", () => {
    writeSession("a.jsonl", [H1, E1, "bad{{{", "also-bad", E2]);
    const src = scanSessionFiles(root)[0]!;
    const r = cloneSession(src, {});
    expect(r.ok).toBe(true);
    expect(r.message).toContain("（跳过 2 行损坏数据）");
  });

  it("transfer 容错消息：跳过行警告接入 message，且源删除语义不变", () => {
    writeSession("a.jsonl", [H1, E1, "this-is-not-json{{{", E2]);
    const src = scanSessionFiles(root)[0]!;
    const r = transferSession(src, { templateId: "t2" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("（跳过 1 行损坏数据）");
    expect(fs.existsSync(src.file)).toBe(false); // 警告不改变转移语义：源仍删除
  });

  it("branch 容错消息：forkSessionAtNode 的 message 也接入跳过警告", () => {
    writeSession("a.jsonl", [H1, E1, "this-is-not-json{{{", E2]);
    const src = scanSessionFiles(root)[0]!;
    const r = forkSessionAtNode(src, { at: "e2" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("（跳过 1 行损坏数据）");
  });

  it("branch compaction 完整性：firstKeptEntryId 引用不在主线时调整（保留 compaction + 警告）", () => {
    // 主线 e1→e6(compaction, firstKeptEntryId=e2)→e2→e3；node=e3 时 e2 在主线内 → 完整
    writeSession("a.jsonl", [H1, E1, E6, E2, E3]);
    const src = scanSessionFiles(root)[0]!;
    const r = forkSessionAtNode(src, { at: "e3" });
    expect(r.ok).toBe(true);
    const entries = fs.readFileSync((r.data as { file: string }).file, "utf-8").trim().split("\n").slice(1).map((l) => JSON.parse(l) as any);
    expect(entries.some((e) => e.type === "compaction")).toBe(true);
    expect(entries.some((e) => e.id === "e2")).toBe(true); // firstKeptEntryId 目标在主线内
  });

  it("transfer 运行中的会话：拒绝且源文件不动", () => {
    writeSession("a.jsonl", [H1, E1]);
    const src = scanSessionFiles(root)[0]!;
    const r = transferSession(src, { templateId: "t2" }, true);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("ALREADY_RUNNING");
    expect(fs.existsSync(src.file)).toBe(true);
    expect(fs.readdirSync(path.join(root, "sessions", "t2"))).toHaveLength(0);
  });

  it("transfer 成功后子会话 parentSession 重链到新路径", () => {
    const srcFile = writeSession("a.jsonl", [H1, E1]);
    // 子会话：同模板，parentSession 指向源文件
    const childHeader = H1.replace(
      '"id":"aaaaaaaa-1111-4111-8111-111111111111"',
      `"id":"bbbbbbbb-2222-4222-8222-222222222222","parentSession":"${srcFile}"`,
    );
    writeSession("child.jsonl", [childHeader, E1]);
    const src = scanSessionFiles(root).find((f) => f.id === "aaaaaaaa-1111-4111-8111-111111111111")!;
    const r = transferSession(src, { templateId: "t2" }, false);
    expect(r.ok).toBe(true);
    const dest = (r.data as { file: string }).file;
    const child = scanSessionFiles(root).find((f) => f.id === "bbbbbbbb-2222-4222-8222-222222222222")!;
    expect(child.parentSession).toBe(dest);
  });
});
