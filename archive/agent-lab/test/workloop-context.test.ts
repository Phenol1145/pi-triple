import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkContext, WorkMessage } from "../src/workloop/contracts.ts";
import { createContextOperations } from "../src/workloop/context.ts";

function base(): WorkContext {
  return {
    systemPrompt: "system",
    messages: [{ role: "user", content: "one" }],
    tools: [{ name: "read" }],
    metadata: { contextId: "c1", sourceRefs: ["source-1"], artifactRefs: [] },
  };
}

function baseWithFour(): WorkContext {
  return {
    systemPrompt: "system",
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
      { role: "assistant", content: "four" },
    ],
    metadata: { contextId: "c1", sourceRefs: ["source-1"], artifactRefs: [] },
  };
}

test("append returns a new context with additional messages and parentContextId", () => {
  const ops = createContextOperations();
  const b = base();
  const appended = ops.append(b, [{ role: "assistant", content: "two" }], "c2");

  // new context is a different object
  assert.notStrictEqual(appended, b);
  // base is not mutated
  assert.strictEqual(b.messages.length, 1);
  assert.strictEqual(b.metadata.contextId, "c1");
  assert.strictEqual(b.metadata.parentContextId, undefined);
  // appended has parentContextId set to the original contextId
  assert.strictEqual(appended.metadata.contextId, "c2");
  assert.strictEqual(appended.metadata.parentContextId, "c1");
  // appended has two messages (original + new)
  assert.strictEqual(appended.messages.length, 2);
  assert.deepStrictEqual(appended.messages[0], { role: "user", content: "one" });
  assert.deepStrictEqual(appended.messages[1], { role: "assistant", content: "two" });
  // systemPrompt is preserved
  assert.strictEqual(appended.systemPrompt, "system");
  // tools are preserved
  assert.deepStrictEqual(appended.tools, [{ name: "read" }]);
});

test("filterMessages returns zero messages without mutating base", () => {
  const ops = createContextOperations();
  const b = base();
  const filtered = ops.filterMessages(b, () => false, "c2");

  // new context is a different object
  assert.notStrictEqual(filtered, b);
  // base is not mutated
  assert.strictEqual(b.messages.length, 1);
  assert.strictEqual(b.metadata.contextId, "c1");
  // filtered has zero messages
  assert.strictEqual(filtered.messages.length, 0);
  // filtered has parentContextId set
  assert.strictEqual(filtered.metadata.contextId, "c2");
  assert.strictEqual(filtered.metadata.parentContextId, "c1");
});

test("merge concatenates messages, deduplicates refs and tools", () => {
  const ops = createContextOperations();
  const b = base();
  const other: WorkContext = {
    systemPrompt: "other-system",
    messages: [
      { role: "assistant", content: "extra" },
      { role: "user", content: "one" }, // duplicate of base's only message
    ],
    tools: [
      { name: "read", extra: true }, // same name as base, different extras
      { name: "write" },
    ],
    metadata: {
      contextId: "c-other",
      sourceRefs: ["source-2", "source-1"], // source-1 is duplicate
      artifactRefs: ["artifact-1", "artifact-2"],
    },
  };

  const merged = ops.merge(b, other, "c3");

  // new context is different object
  assert.notStrictEqual(merged, b);
  assert.notStrictEqual(merged, other);
  // base is not mutated
  assert.strictEqual(b.messages.length, 1);
  assert.strictEqual(b.metadata.contextId, "c1");
  // contextId is set
  assert.strictEqual(merged.metadata.contextId, "c3");
  // parentContextId is not set on merge (merge joins two independent contexts)
  assert.strictEqual(merged.metadata.parentContextId, undefined);
  // messages concatenated: base first, then other
  assert.strictEqual(merged.messages.length, 3);
  assert.deepStrictEqual(merged.messages[0], { role: "user", content: "one" });
  assert.deepStrictEqual(merged.messages[1], { role: "assistant", content: "extra" });
  assert.deepStrictEqual(merged.messages[2], { role: "user", content: "one" });
  // sourceRefs deduplicated, first-seen order: base has source-1, other has source-2 then source-1
  assert.deepStrictEqual(merged.metadata.sourceRefs, ["source-1", "source-2"]);
  // artifactRefs deduplicated, first-seen order: base has [], other has artifact-1, artifact-2
  assert.deepStrictEqual(merged.metadata.artifactRefs, ["artifact-1", "artifact-2"]);
  // base has systemPrompt, so base's systemPrompt is used (not other's)
  assert.strictEqual(merged.systemPrompt, "system");
  // tools deduplicated by name: read from base kept, write added
  assert.strictEqual(merged.tools!.length, 2);
  const readTool = merged.tools!.find(t => t.name === "read");
  const writeTool = merged.tools!.find(t => t.name === "write");
  assert.ok(readTool);
  assert.ok(writeTool);
  // base's read tool is the one kept (first-seen)
  assert.deepStrictEqual(readTool, { name: "read" });
  assert.deepStrictEqual(writeTool, { name: "write" });
});

test("merge uses other.systemPrompt only when base has none", () => {
  const ops = createContextOperations();
  const b: WorkContext = {
    messages: [{ role: "user", content: "one" }],
    metadata: { contextId: "c1", sourceRefs: [], artifactRefs: [] },
  };
  const other: WorkContext = {
    systemPrompt: "other-system",
    messages: [],
    metadata: { contextId: "c-other", sourceRefs: [], artifactRefs: [] },
  };

  const merged = ops.merge(b, other, "c3");
  assert.strictEqual(merged.systemPrompt, "other-system");
});

test("truncateMessages keeps the newest N messages", () => {
  const ops = createContextOperations();
  const b = baseWithFour();
  const truncated = ops.truncateMessages(b, 2, "c2");

  // new context
  assert.notStrictEqual(truncated, b);
  // base not mutated
  assert.strictEqual(b.messages.length, 4);
  // truncated has newest 2 messages
  assert.strictEqual(truncated.messages.length, 2);
  assert.deepStrictEqual(truncated.messages[0], { role: "user", content: "three" });
  assert.deepStrictEqual(truncated.messages[1], { role: "assistant", content: "four" });
  assert.strictEqual(truncated.metadata.contextId, "c2");
  assert.strictEqual(truncated.metadata.parentContextId, "c1");
});

test("truncateMessages throws for negative limit", () => {
  const ops = createContextOperations();
  assert.throws(
    () => ops.truncateMessages(baseWithFour(), -1, "c2"),
    /message limit must be a nonnegative integer/,
  );
});

test("truncateMessages throws for non-integer limit", () => {
  const ops = createContextOperations();
  assert.throws(
    () => ops.truncateMessages(baseWithFour(), 1.5, "c2"),
    /message limit must be a nonnegative integer/,
  );
});

test("truncateMessages with limit 0 returns zero messages", () => {
  const ops = createContextOperations();
  const b = baseWithFour();
  const truncated = ops.truncateMessages(b, 0, "c2");

  // new context, base not mutated
  assert.notStrictEqual(truncated, b);
  assert.strictEqual(b.messages.length, 4);
  // limit 0 yields zero messages
  assert.strictEqual(truncated.messages.length, 0);
  assert.strictEqual(truncated.metadata.contextId, "c2");
  assert.strictEqual(truncated.metadata.parentContextId, "c1");
  // limit 1 still works correctly
  const one = ops.truncateMessages(b, 1, "c3");
  assert.strictEqual(one.messages.length, 1);
  assert.deepStrictEqual(one.messages[0], { role: "assistant", content: "four" });
  // limit 2 still works correctly
  const two = ops.truncateMessages(b, 2, "c4");
  assert.strictEqual(two.messages.length, 2);
});
