// 最小 JSON Schema 子集校验器测试（装配层 Task 8，协调者裁决：零依赖手工校验）。
// 子集：required / properties.<k>.type / properties.<k>.enum / type（顶层）/ oneOf / items；
// 未知关键字忽略；schema 非对象 → ["configSchema invalid"]。
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAgainstSchema } from "../src/assembly/json-schema-min.ts";

test("empty schema passes any value", () => {
  assert.deepEqual(validateAgainstSchema({ a: 1 }, {}), []);
  assert.deepEqual(validateAgainstSchema("x", {}), []);
});

test("top-level type mismatch → config: expected <type>", () => {
  assert.deepEqual(validateAgainstSchema("x", { type: "object" }), ["config: expected object"]);
  assert.deepEqual(validateAgainstSchema([], { type: "object" }), ["config: expected object"]);
  assert.deepEqual(validateAgainstSchema(null, { type: "object" }), ["config: expected object"]);
  assert.deepEqual(validateAgainstSchema(42, { type: "string" }), ["config: expected string"]);
});

test("array type passes", () => {
  assert.deepEqual(validateAgainstSchema([1, 2], { type: "array" }), []);
});

test("required missing → config.<prop>: required", () => {
  const schema = { type: "object", required: ["agent", "cwd"] };
  assert.deepEqual(validateAgainstSchema({ agent: "a" }, schema), ["config.cwd: required"]);
  assert.deepEqual(validateAgainstSchema({ agent: "a", cwd: "." }, schema), []);
});

test("property type mismatch → config.<prop>: expected <type>", () => {
  const schema = { type: "object", properties: { model: { type: "string" }, k: { type: "number" } } };
  assert.deepEqual(validateAgainstSchema({ model: 42 }, schema), ["config.model: expected string"]);
  assert.deepEqual(validateAgainstSchema({ model: "m", k: "x" }, schema), ["config.k: expected number"]);
  assert.deepEqual(validateAgainstSchema({ model: "m", k: 1 }, schema), []);
});

test("enum violation → config.<prop>: must be one of [...]", () => {
  const schema = {
    type: "object",
    properties: { contextMode: { type: "string", enum: ["fresh", "fork"] } },
  };
  assert.deepEqual(validateAgainstSchema({ contextMode: "other" }, schema), [
    'config.contextMode: must be one of ["fresh","fork"]',
  ]);
  assert.deepEqual(validateAgainstSchema({ contextMode: "fresh" }, schema), []);
});

test("oneOf: any branch passes → ok; all fail → no oneOf branch matched", () => {
  // pi-default-loop result.oneOf 形状（const 关键字不在子集 → 忽略，靠 type/enum 分支判定）
  const schema = {
    type: "object",
    properties: {
      result: {
        oneOf: [
          { type: "object", properties: { kind: { type: "string", enum: ["text"] } } },
          {
            type: "object",
            properties: { kind: { type: "string", enum: ["structured"] }, schema: { type: "object" } },
          },
        ],
      },
    },
  };
  assert.deepEqual(validateAgainstSchema({ result: { kind: "text" } }, schema), []);
  assert.deepEqual(validateAgainstSchema({ result: { kind: "structured", schema: {} } }, schema), []);
  assert.deepEqual(validateAgainstSchema({ result: { kind: "nope" } }, schema), [
    "config.result: no oneOf branch matched",
  ]);
});

test("items: array element recursion", () => {
  const schema = { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } };
  assert.deepEqual(validateAgainstSchema({ tags: ["a", 1] }, schema), ["config.tags[1]: expected string"]);
  assert.deepEqual(validateAgainstSchema({ tags: ["a", "b"] }, schema), []);
});

test("nested object paths", () => {
  const schema = { type: "object", properties: { a: { type: "object", required: ["b"] } } };
  assert.deepEqual(validateAgainstSchema({ a: {} }, schema), ["config.a.b: required"]);
  assert.deepEqual(validateAgainstSchema({ a: { b: 1 } }, schema), []);
});

test("unknown keywords ignored (minimum/maximum/format/pattern/const)", () => {
  const schema = {
    type: "object",
    properties: {
      x: { type: "number", minimum: 5, maximum: 10, format: "int32" },
      kind: { const: "text" },
    },
  };
  assert.deepEqual(validateAgainstSchema({ x: 7, kind: "text" }, schema), []);
});

test("non-object schema → configSchema invalid", () => {
  assert.deepEqual(validateAgainstSchema({}, null as never), ["configSchema invalid"]);
  assert.deepEqual(validateAgainstSchema({}, "nope" as never), ["configSchema invalid"]);
  assert.deepEqual(validateAgainstSchema({}, [1] as never), ["configSchema invalid"]);
});
