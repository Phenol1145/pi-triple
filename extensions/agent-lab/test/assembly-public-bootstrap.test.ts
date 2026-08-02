import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublicDomainBootstrap } from "../src/assembly/public-bootstrap.ts";
import { PublicDomainStore } from "../src/memory/public-domain.ts";

test("ensureInitialized seeds axiom + base rules idempotently", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asm-pub-"));
  const pb = new PublicDomainBootstrap(dir);
  pb.ensureInitialized();
  pb.ensureInitialized();   // 幂等（不重复）
  const store = new PublicDomainStore(dir);
  const entries = store.listOfficialEntries();
  assert.ok(entries.length >= 3);                     // 公理 + fact 规则 + experience/preference 规则
  assert.ok(entries.some((e) => e.kind === "axiom"));
  assert.ok(entries.filter((e) => e.kind === "rule").length >= 2);
  rmSync(dir, { recursive: true, force: true });
});
