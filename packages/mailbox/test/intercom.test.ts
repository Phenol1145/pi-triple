/**
 * @away_from/mailbox unit tests（原 pit-communicate，/pit 已改名 /mail）
 * 从包入口 import，mailbox root 用 tmpdir 隔离
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 包入口导入（mailbox 包 + shared 包）
import { Mailbox, createMessage, validateMessage, Delivery } from "@away_from/mailbox";
import { Presence, Registry } from "@away_from/shared";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ptl-intercom-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// === Protocol ===
describe("Protocol", () => {
  it("createMessage has id and defaults", () => {
    const msg = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text",
      content: "Hello from coding!",
    });
    expect(typeof msg.id).toBe("string");
    expect(msg.id.length).toBeGreaterThan(0);
    expect(msg.priority).toBe("normal");
    expect(msg.hop).toBe(0);
    expect(msg.schemaVersion).toBe(1);
  });

  it("validateMessage ok", () => {
    const msg = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text", content: "Hello",
    });
    expect(validateMessage(msg)).not.toBeNull();
  });

  it("validateMessage null for bad input", () => {
    expect(validateMessage(null)).toBeNull();
    expect(validateMessage({ foo: 1 })).toBeNull();
  });
});

// === Mailbox ===
describe("Mailbox", () => {
  it("send + readPending + accept", () => {
    const mb = new Mailbox(root, "local", "s2");
    const msg = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text", content: "Hello!",
    });
    mb.send(msg);
    const pending = mb.readPending();
    expect(pending.length).toBe(1);
    expect(pending[0].content).toBe("Hello!");

    mb.accept(msg.id);
    expect(mb.readPending().length).toBe(0);
    expect(fs.readdirSync(mb.acceptedDir).length).toBe(1);
  });

  it("reject", () => {
    const mb = new Mailbox(root, "local", "s2");
    const msg = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text", content: "Reject me",
    });
    mb.send(msg);
    mb.reject(msg.id);
    expect(fs.readdirSync(mb.rejectedDir).length).toBe(1);
  });

  it("sendFile meta + copy", () => {
    const mb = new Mailbox(root, "local", "s2");
    const testFile = path.join(root, "report.txt");
    fs.writeFileSync(testFile, "Q3 Report");
    const fileMsg = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "file", content: "Report", filePath: testFile, fileSize: 9,
    });
    mb.sendFile(fileMsg, testFile);
    const fileDir = path.join(mb.pendingDir, `file-${fileMsg.id}`);
    expect(fs.existsSync(path.join(fileDir, "meta.json"))).toBe(true);
    expect(fs.readFileSync(path.join(fileDir, "report.txt"), "utf-8")).toBe("Q3 Report");
  });
});

// === Presence ===
describe("Presence", () => {
  it("heartbeat, online, status, cleanup", () => {
    const mb = new Mailbox(root, "local", "s1");
    const p = new Presence(mb.baseDir, {
      pid: process.pid, status: "idle", name: "coding", model: "test",
      mode: "manual", startedAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    });
    p.start();
    const statePath = path.join(mb.baseDir, "state.json");
    expect(fs.existsSync(statePath)).toBe(true);
    expect(Presence.isOnline(statePath)).toBe(true);
    expect(Presence.read(statePath)?.name).toBe("coding");
    p.setStatus("busy");
    expect(Presence.read(statePath)?.status).toBe("busy");
    p.cleanup();
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("updateName 静态更新 name 且不破坏其他字段", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-updatename-"));
    try {
      const statePath = path.join(dir, "state.json");
      const p = new Presence(dir, {
        pid: 123, status: "idle", name: "old", model: "m", mode: "manual",
        startedAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
      });
      p.start();
      const ok = Presence.updateName(statePath, "new-name");
      expect(ok).toBe(true);
      const state = Presence.read(statePath);
      expect(state?.name).toBe("new-name");
      expect(state?.pid).toBe(123);
      p.cleanup();
      // 文件不存在 → false
      expect(Presence.updateName(path.join(dir, "nope.json"), "x")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// === Registry ===
describe("Registry", () => {
  it("register, unregister, list", () => {
    const reg = new Registry(root, "local");
    reg.register({ sessionId: "s1", tenantId: "local", name: "coding", pid: process.pid, startedAt: new Date().toISOString() });
    reg.register({ sessionId: "s2", tenantId: "local", name: "review", pid: process.pid + 1, startedAt: new Date().toISOString() });
    expect(reg.list().length).toBe(2);
    reg.unregister("s2");
    expect(reg.list().length).toBe(1);
  });
});

// === Delivery ===
describe("Delivery", () => {
  it("manual mode: notify + acceptAndInject", () => {
    const delivery = new Delivery({ defaultMode: "manual" });
    const msg = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text", content: "Manual test",
    });
    const d1 = delivery.process(msg);
    expect(d1.action).toBe("notify");
    const d1b = delivery.acceptAndInject(msg);
    expect(d1b.action).toBe("accept-and-inject");
  });

  it("auto mode: inject-next-turn + dedup", () => {
    const delivery = new Delivery({ defaultMode: "auto" });
    const msg = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text", content: "Auto test",
    });
    expect(delivery.process(msg).action).toBe("inject-next-turn");
    expect(delivery.process(msg).action).toBe("skip");
  });

  it("hybrid + urgent: inject-steer-and-notify", () => {
    const delivery = new Delivery({ defaultMode: "hybrid" });
    const urgentMsg = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text", content: "Urgent!", priority: "urgent",
    });
    expect(delivery.process(urgentMsg).action).toBe("inject-steer-and-notify");
  });

  it("auto mode: 超长注入内容截断 + 截断标记（H2 护栏）", () => {
    const delivery = new Delivery({ defaultMode: "auto" });
    const long = "x".repeat(20000);
    const msg = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text", content: long,
    });
    const d = delivery.process(msg);
    expect(d.action).toBe("inject-next-turn");
    const content = (d as { content: string }).content;
    expect(content.length).toBeLessThan(20000); // 已截断（原始 20000）
    expect(content.startsWith("x".repeat(8000))).toBe(true); // 主体 8000
    expect(content.endsWith("[内容过长已截断]")).toBe(true);
  });

  it("auto mode: 同 sender 注入速率限制——窗口内第 2 条降级为 notify（H2 护栏）", () => {
    const delivery = new Delivery({ defaultMode: "auto" });
    const mk = (content: string) => createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text", content,
    });
    expect(delivery.process(mk("first")).action).toBe("inject-next-turn");
    // 同 sender 同窗口内第二条 → 不得再注入（防会话间 DoS）
    expect(delivery.process(mk("second")).action).toBe("notify");
    // 不同 sender 不受限
    const other = createMessage({
      from: { sessionId: "s3", tenantId: "local", name: "writer" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text", content: "other",
    });
    expect(delivery.process(other).action).toBe("inject-next-turn");
  });

  it("validateMessage: 缺 from.name / 非法 priority / 超长 content → 拒绝（H2 护栏）", () => {
    const base = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2", tenantId: "local" },
      type: "text", content: "hi",
    });
    expect(validateMessage({ ...base, from: { ...base.from, name: "" } })).toBeNull();
    expect(validateMessage({ ...base, priority: "critical" })).toBeNull();
    expect(validateMessage({ ...base, content: "x".repeat(100001) })).toBeNull();
    expect(validateMessage(base)).not.toBeNull();
  });

  it("gc cleans old", async () => {
    const mb = new Mailbox(root, "local", "s2-gc");
    const msg = createMessage({
      from: { sessionId: "s1", tenantId: "local", name: "coding" },
      to: { sessionId: "s2-gc", tenantId: "local" },
      type: "text", content: "Will be GC'd",
    });
    mb.send(msg);
    mb.accept(msg.id);
    // 等文件落盘，用 -1 清除所有已接受消息（无时间限制）
    await new Promise((r) => setTimeout(r, 10));
    const cleaned = mb.gc(-1);
    expect(cleaned).toBeGreaterThanOrEqual(1);
  });
});
