import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreRepository } from "../src/core/storage/repository.ts";
import { SqliteTaskStore } from "../src/taskpool/tasks.ts";
import { mountSorterSdk, type SorterSdkPort } from "../src/taskpool/sdk.ts";

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-sdk-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  new CoreRepository(db);
  const store = new SqliteTaskStore({ db, appendEvent: () => "inserted", traceId: "test" });
  const sdk: { sorter?: SorterSdkPort } = {};
  mountSorterSdk(sdk, { store, agentId: () => "agent-a" });
  return { dir, db, store, sdk };
}

test("submitTask：本人可提交 → {ok:true}；守卫失败 → {ok:false,error}", async () => {
  const { dir, db, store, sdk } = fresh();
  const t = store.publish({ templateId: "x", text: "t", labels: [], createdBy: "me" });
  store.claim("agent-a", t.id);
  const r1 = sdk.sorter.submitTask(t.id, "memory:entry-9");
  assert.deepEqual(r1, { ok: true });
  // 已完成的再提交 → 守卫失败
  const r2 = sdk.sorter.submitTask(t.id, "again");
  assert.equal(r2.ok, false);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("rejectTask：本人可拒 → {ok:true}；他人/未认领 → {ok:false}", async () => {
  const { dir, db, store, sdk } = fresh();
  const t = store.publish({ templateId: "x", text: "t", labels: [], createdBy: "me" });
  const r0 = sdk.sorter.rejectTask(t.id, "未认领");
  assert.equal(r0.ok, false);
  store.claim("agent-b", t.id); // 他人认领
  const r1 = sdk.sorter.rejectTask(t.id, "不是我的");
  assert.equal(r1.ok, false);
  const t2 = store.publish({ templateId: "x", text: "t2", labels: [], createdBy: "me" });
  store.claim("agent-a", t2.id);
  const r2 = sdk.sorter.rejectTask(t2.id, "缺工具");
  assert.deepEqual(r2, { ok: true });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("防御性挂载：store 缺失不挂", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskpool-sdk-"));
  const db = new DatabaseSync(path.join(dir, "t.db"));
  new CoreRepository(db);
  const sdk: { sorter?: unknown } = {};
  mountSorterSdk(sdk, { store: undefined as never, agentId: () => "x" });
  assert.equal(sdk.sorter, undefined);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
