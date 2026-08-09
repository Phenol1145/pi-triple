import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { NamespacedStore, VersionConflictError } from "../src/core/storage/namespaced-store.ts";

function setup() {
  const db = new DatabaseSync(":memory:");
  return { db, store: new NamespacedStore(db) };
}

test("NamespacedStore creates at expected version 0 and increments versions", () => {
  const { db, store } = setup();
  assert.deepEqual(store.put("scheduler:s1", "state", { n: 1 }, 0), { value: { n: 1 }, version: 1 });
  assert.deepEqual(store.put("scheduler:s1", "state", { n: 2 }, 1), { value: { n: 2 }, version: 2 });
  assert.deepEqual(store.get("scheduler:s1", "state"), { value: { n: 2 }, version: 2 });
  db.close();
});

test("NamespacedStore rejects stale writers", () => {
  const { db, store } = setup();
  store.put("agent:a1", "runtime", { step: 1 }, 0);
  assert.throws(() => store.put("agent:a1", "runtime", { step: 2 }, 0), VersionConflictError);
  assert.deepEqual(store.get("agent:a1", "runtime"), { value: { step: 1 }, version: 1 });
  db.close();
});

test("NamespacedStore isolates equal keys across namespaces", () => {
  const { db, store } = setup();
  store.put("scheduler:s1", "state", "one", 0);
  store.put("scheduler:s2", "state", "two", 0);
  assert.equal(store.get("scheduler:s1", "state")?.value, "one");
  assert.equal(store.get("scheduler:s2", "state")?.value, "two");
  db.close();
});

test("NamespacedStore delete requires the current version", () => {
  const { db, store } = setup();
  store.put("agent:a1", "state", { ok: true }, 0);
  assert.throws(() => store.delete("agent:a1", "state", 0), VersionConflictError);
  store.delete("agent:a1", "state", 1);
  assert.equal(store.get("agent:a1", "state"), undefined);
  db.close();
});
