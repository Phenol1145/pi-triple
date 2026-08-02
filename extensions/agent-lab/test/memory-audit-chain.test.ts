import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditChain, type AuditConfig, type AuditRequest } from "../src/memory/audit-chain.ts";

function cfg(over: Partial<AuditConfig> = {}): AuditConfig {
  return { agentSide: "all-vote", operatorSide: "auto-approve", ...over };
}
const agents = { active: () => ["a1", "a2", "a3"], isActive: () => true };
const op = { notify: () => {}, veto: () => false };
const req: AuditRequest = { id: "r1", delta: { entryId: "e1", kind: "fact" }, domain: "team" };

// ---- brief 测试（5 个逐字） ----

test("all-vote passes with majority, operator auto-approve", () => {
  const chain = new AuditChain(cfg(), agents, op);
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  chain.vote({ requestId: "r1", voter: "a2", decision: "approve", at: 2 });
  assert.equal(chain.approve(req), true);
});

test("all-vote rejects on majority reject", () => {
  const chain = new AuditChain(cfg(), agents, op);
  chain.vote({ requestId: "r1", voter: "a1", decision: "reject", at: 1 });
  chain.vote({ requestId: "r1", voter: "a2", decision: "reject", at: 2 });
  assert.equal(chain.approve(req), false);
});

test("veto strategy: any veto rejects, no-veto passes without majority", () => {
  const chain = new AuditChain(cfg({ agentSide: "veto" }), agents, op);
  chain.vote({ requestId: "r1", voter: "a1", decision: "veto", at: 1 });
  assert.equal(chain.approve(req), false);
  const chain2 = new AuditChain(cfg({ agentSide: "veto" }), agents, op);
  assert.equal(chain2.approve(req), true);   // 无 veto = 通过
});

test("operator veto overrides agent approval", () => {
  const chain = new AuditChain(cfg({ operatorSide: "manual" }), agents, { notify: () => {}, veto: () => true });
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  chain.vote({ requestId: "r1", voter: "a2", decision: "approve", at: 2 });
  assert.equal(chain.approve(req), false);   // operator 一票否决
});

test("quorum: abstentions count into denominator", () => {
  const chain = new AuditChain(cfg(), agents, op);   // 3 活跃，需过半（2）
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  assert.equal(chain.approve(req), false);           // 1/3 不过半（弃权计入分母）
});

// ---- 补充测试（矩阵其余格子 / 生命周期 / 文件落盘） ----

test("all-vote tie (equal approve/reject) goes to operator", () => {
  const chain = new AuditChain(cfg(), agents, op);   // auto-approve → operator 批准
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  chain.vote({ requestId: "r1", voter: "a2", decision: "reject", at: 2 });
  assert.equal(chain.approve(req), true);
  const chainD = new AuditChain(cfg({ operatorSide: "delegate" }), agents, op); // delegate → 无决议不通过
  chainD.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  chainD.vote({ requestId: "r1", voter: "a2", decision: "reject", at: 2 });
  assert.equal(chainD.approve(req), false);
});

test("veto: offline voter's veto is abstention (no veto)", () => {
  const offlineRegistry = { active: () => ["a1", "a2", "a3"], isActive: (id: string) => id !== "a9" };
  const chain = new AuditChain(cfg({ agentSide: "veto" }), offlineRegistry, op);
  chain.vote({ requestId: "r1", voter: "a9", decision: "veto", at: 1 });
  assert.equal(chain.approve(req), true);   // 离线 = 弃权，不否决
});

test("representative: majority of representatives decides", () => {
  const chain = new AuditChain(cfg({ agentSide: "representative" }), agents, op);
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  chain.vote({ requestId: "r1", voter: "a2", decision: "approve", at: 2 });
  assert.equal(chain.approve(req), true);   // 2 代表全赞成 → 通过
});

test("representative: abstention replaced by substitute", () => {
  const chain = new AuditChain(cfg({ agentSide: "representative" }), agents, op);
  // 代表 = [a1, a2]（active 前 2）；a1 弃权 → 换选补充 a3；a3 赞成 + a2 赞成 → 2/2 通过
  chain.vote({ requestId: "r1", voter: "a2", decision: "approve", at: 2 });
  chain.vote({ requestId: "r1", voter: "a3", decision: "approve", at: 3 });
  assert.equal(chain.approve(req), true);
});

test("representative: split goes to operator (manual no-veto passes)", () => {
  const chain = new AuditChain(cfg({ agentSide: "representative", operatorSide: "manual" }), agents, op);
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  chain.vote({ requestId: "r1", voter: "a2", decision: "reject", at: 2 });
  assert.equal(chain.approve(req), true);   // 分歧 → operator 未否决 → 通过
});

test("operator veto is final in every strategy (auto-approve)", () => {
  const chain = new AuditChain(cfg({ operatorSide: "auto-approve" }), agents, { notify: () => {}, veto: () => true });
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  chain.vote({ requestId: "r1", voter: "a2", decision: "approve", at: 2 });
  assert.equal(chain.approve(req), false);   // operator 最终否决权（可推翻 agent 通过）
});

test("submit takes active snapshot; duplicate request rejected", async () => {
  const chain = new AuditChain(cfg(), agents, op);
  const r1 = await chain.submit(req);
  assert.equal(r1.ok, true);
  if (r1.ok) assert.equal(r1.requestId, "r1");
  const r2 = await chain.submit(req);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "duplicate-request");
});

test("closeWindow hard-cuts votes after close", () => {
  const chain = new AuditChain(cfg(), agents, op);
  chain.vote({ requestId: "r1", voter: "a1", decision: "approve", at: 1 });
  chain.closeWindow("r1");
  chain.vote({ requestId: "r1", voter: "a2", decision: "approve", at: 2 });   // 窗口关闭后不计
  assert.equal(chain.approve(req), false);   // 1/3 不过半
});

test("recordEvent appends audit events jsonl only", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-audit-"));
  const chain = new AuditChain(cfg(), agents, op, dir);
  chain.recordEvent({ type: "audit", requestId: "r1", verdict: "approved", at: 1 });
  chain.recordEvent({ type: "audit", requestId: "r2", verdict: "rejected", at: 2 });
  const lines = readFileSync(path.join(dir, "audit-events.jsonl"), "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[0]) as { verdict: string }).verdict, "approved");
  assert.equal(existsSync(path.join(dir, "entries")), false);   // 不落 L3（无条目库）
  rmSync(dir, { recursive: true, force: true });
});

test("markNotWriteBack appends and dedupes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-audit-"));
  const chain = new AuditChain(cfg(), agents, op, dir);
  chain.markNotWriteBack("e1");
  chain.markNotWriteBack("e1");   // 幂等：重复标记不追加
  chain.markNotWriteBack("e2");
  const lines = readFileSync(path.join(dir, "not-write-back.jsonl"), "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  const ids = lines.map((l) => (JSON.parse(l) as { entryId: string }).entryId).sort();
  assert.deepEqual(ids, ["e1", "e2"]);
  rmSync(dir, { recursive: true, force: true });
});
