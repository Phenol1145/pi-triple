/**
 * pit-mail 端到端测试
 * 运行: npx tsx test-intercom.ts
 */
import fs from "node:fs";
import path from "node:path";

// 直接导入 .ts 文件
const ext = ".pi-platform-data/shared/extensions/pit-mail";
const { Mailbox } = await import(`./${ext}/mailbox.ts`);
const { createMessage, validateMessage } = await import(`./${ext}/protocol.ts`);
const { Presence } = await import(`./${ext}/presence.ts`);
const { Registry } = await import(`./${ext}/registry.ts`);
const { Delivery } = await import(`./${ext}/delivery.ts`);

const root = `/tmp/pit-mail-test-${Date.now()}`;
let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

console.log(`\n测试目录: ${root}\n`);

// === Protocol ===
console.log("=== Protocol ===");
const msg = createMessage({
  from: { sessionId: "s1", tenantId: "local", name: "coding" },
  to: { sessionId: "s2", tenantId: "local" },
  type: "text",
  content: "Hello from coding!",
});
assert("createMessage has id", typeof msg.id === "string" && msg.id.length > 0);
assert("createMessage defaults", msg.priority === "normal" && msg.hop === 0 && msg.schemaVersion === 1);
assert("validateMessage ok", validateMessage(msg) !== null);
assert("validateMessage null", validateMessage(null) === null);
assert("validateMessage bad", validateMessage({ foo: 1 }) === null);

// === Mailbox ===
console.log("\n=== Mailbox ===");
const mb2 = new Mailbox(root, "local", "s2");
mb2.send(msg);
const pending = mb2.readPending();
assert("send + readPending", pending.length === 1 && pending[0].content === "Hello from coding!");

mb2.accept(msg.id);
assert("accept moves to accepted", mb2.readPending().length === 0);
assert("accepted dir has file", fs.readdirSync(mb2.acceptedDir).length === 1);

const msg2 = createMessage({
  from: { sessionId: "s1", tenantId: "local", name: "coding" },
  to: { sessionId: "s2", tenantId: "local" },
  type: "text", content: "Reject me",
});
mb2.send(msg2);
mb2.reject(msg2.id);
assert("reject moves to rejected", fs.readdirSync(mb2.rejectedDir).length === 1);

// === File share ===
console.log("\n=== File share ===");
const testFile = path.join(root, "report.txt");
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(testFile, "Q3 Report");
const fileMsg = createMessage({
  from: { sessionId: "s1", tenantId: "local", name: "coding" },
  to: { sessionId: "s2", tenantId: "local" },
  type: "file", content: "Report", filePath: testFile, fileSize: 9,
});
mb2.sendFile(fileMsg, testFile);
const fileDir = path.join(mb2.pendingDir, `file-${fileMsg.id}`);
assert("sendFile meta", fs.existsSync(path.join(fileDir, "meta.json")));
assert("sendFile copy", fs.readFileSync(path.join(fileDir, "report.txt"), "utf-8") === "Q3 Report");

// === Presence ===
console.log("\n=== Presence ===");
const mb1 = new Mailbox(root, "local", "s1");
const p1 = new Presence(mb1.baseDir, {
  pid: process.pid, status: "idle", name: "coding", model: "test",
  mode: "manual", startedAt: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
});
p1.start();
const statePath = path.join(mb1.baseDir, "state.json");
assert("heartbeat written", fs.existsSync(statePath));
assert("isOnline", Presence.isOnline(statePath));
assert("read state", Presence.read(statePath)?.name === "coding");
p1.setStatus("busy");
assert("setStatus busy", Presence.read(statePath)?.status === "busy");
p1.cleanup();
assert("cleanup removes state", !fs.existsSync(statePath));

// === Registry ===
console.log("\n=== Registry ===");
const reg = new Registry(root, "local");
reg.register({ sessionId: "s1", tenantId: "local", name: "coding", pid: process.pid, startedAt: new Date().toISOString() });
reg.register({ sessionId: "s2", tenantId: "local", name: "review", pid: process.pid + 1, startedAt: new Date().toISOString() });
assert("register 2", reg.list().length === 2);
reg.unregister("s2");
assert("unregister", reg.list().length === 1);

// === Delivery ===
console.log("\n=== Delivery (manual) ===");
const delivery = new Delivery({ defaultMode: "manual" });
const msg3 = createMessage({
  from: { sessionId: "s1", tenantId: "local", name: "coding" },
  to: { sessionId: "s2", tenantId: "local" },
  type: "text", content: "Manual test",
});
const d1 = delivery.process(msg3);
assert("manual: notify decision", d1.action === "notify");
const d1b = delivery.acceptAndInject(msg3);
assert("manual: acceptAndInject", d1b.action === "accept-and-inject");

console.log("\n=== Delivery (auto) ===");
const delivery2 = new Delivery({ defaultMode: "auto" });
const msg4 = createMessage({
  from: { sessionId: "s1", tenantId: "local", name: "coding" },
  to: { sessionId: "s2", tenantId: "local" },
  type: "text", content: "Auto test",
});
const d2 = delivery2.process(msg4);
assert("auto: inject-next-turn", d2.action === "inject-next-turn");
const d2b = delivery2.process(msg4);
assert("auto: dedup skip", d2b.action === "skip");

console.log("\n=== Delivery (hybrid + urgent) ===");
const delivery3 = new Delivery({ defaultMode: "hybrid" });
const urgentMsg = createMessage({
  from: { sessionId: "s1", tenantId: "local", name: "coding" },
  to: { sessionId: "s2", tenantId: "local" },
  type: "text", content: "Urgent!", priority: "urgent",
});
const d3 = delivery3.process(urgentMsg);
assert("hybrid urgent: steer", d3.action === "inject-steer-and-notify");

// === GC ===
console.log("\n=== GC ===");
const cleaned = mb2.gc(0);
assert("gc cleans old", cleaned >= 1);

// Cleanup
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${"=".repeat(40)}`);
console.log(`🎉 ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
