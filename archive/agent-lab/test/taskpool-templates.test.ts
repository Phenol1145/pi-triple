import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTemplateRegistry } from "../src/taskpool/templates.ts";
import { SEMANTIC_SPLIT_TEMPLATE } from "../src/taskpool/semantic-split.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-tpl-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const reg = new SqliteTemplateRegistry(db);
  return { dir, db, reg };
}

test("register 幂等 + get/list", () => {
  const { dir, db, reg } = fresh();
  reg.register(SEMANTIC_SPLIT_TEMPLATE);
  reg.register({ ...SEMANTIC_SPLIT_TEMPLATE, name: "改名" }); // 同 id 二次注册 no-op
  const t = reg.get("semantic-split")!;
  assert.equal(t.name, SEMANTIC_SPLIT_TEMPLATE.name); // 首次生效
  assert.equal(reg.list().length, 1);
  assert.equal(reg.get("不存在"), undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("instantiate 填占位符 + 标签合并", () => {
  const { dir, db, reg } = fresh();
  reg.register(SEMANTIC_SPLIT_TEMPLATE);
  const r = reg.instantiate("semantic-split", { relPath: "docs/x.md" }, ["extra"]);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.text.includes("docs/x.md"));
    assert.ok(r.text.includes("sdk.memory.write"));
    assert.ok(r.labels.includes("memory-maintenance"));
    assert.ok(r.labels.includes("semantic-split"));
    assert.ok(r.labels.includes("extra"));
    assert.ok(!r.text.includes("<relPath>")); // 占位符已替换
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("缺必填参数报错 + 模板不存在报错", () => {
  const { dir, db, reg } = fresh();
  reg.register(SEMANTIC_SPLIT_TEMPLATE);
  const r1 = reg.instantiate("semantic-split", {});
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.ok(r1.error.includes("relPath"));
  const r2 = reg.instantiate("nope", { relPath: "x" });
  assert.equal(r2.ok, false);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
