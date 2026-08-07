import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSessionFiles } from "../../packages/framework/src/session/pi-scan.js";
import { buildSessionTree } from "../../packages/framework/src/session/pi-tree.js";

describe("pi-tree", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tree-"));
    fs.mkdirSync(path.join(root, "sessions", "t1"), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function w(name: string, parentSession?: string): void {
    const parent = parentSession ? `,"parentSession":"${parentSession}"` : "";
    fs.writeFileSync(path.join(root, "sessions", "t1", name), `{"type":"session","version":3,"id":"${name.replace(".jsonl","")}","timestamp":"2026-07-28T00:00:00.000Z","cwd":"/w"${parent}}\n`);
  }

  it("森林渲染：根无缩进，子带缩进，悬空引用标 (deleted)", () => {
    w("root.jsonl");
    w("child.jsonl", path.join(root, "sessions", "t1", "root.jsonl"));
    w("orphan-child.jsonl", "/gone/missing.jsonl");
    const files = scanSessionFiles(root);
    const tree = buildSessionTree(files);
    expect(tree).toContain("root.jsonl");
    expect(tree).toContain("└─");
    expect(tree).toContain("(deleted)");
  });

  it("跨模板引用正常显示（parentSession 指向他模板文件）", () => {
    w("root.jsonl");
    fs.mkdirSync(path.join(root, "sessions", "t2"), { recursive: true });
    fs.writeFileSync(path.join(root, "sessions", "t2", "cross.jsonl"), `{"type":"session","version":3,"id":"cross","timestamp":"2026-07-28T00:00:00.000Z","cwd":"/w","parentSession":"${path.join(root, "sessions", "t1", "root.jsonl")}"}\n`);
    const tree = buildSessionTree(scanSessionFiles(root));
    expect(tree).toContain("cross");
  });
});
