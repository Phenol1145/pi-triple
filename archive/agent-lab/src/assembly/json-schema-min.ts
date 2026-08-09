// 最小 JSON Schema 子集校验器（装配层 Task 8，协调者裁决：零依赖手工校验）。
//
// 步骤 2a 语义：config 过 configSchema —— 用本子集手工校验（WorkLoopDefinition 用
// configSchema（JSON Schema 结构），无 validateParameters 方法（那是 SchedulerDefinition
// 的）；项目无 ajv（零依赖约束），故按最小子集实现）。
//
// 支持子集：
//   - required（数组；缺失 → `config.<prop>: required`）
//   - properties.<k>.type（string/number/boolean/object/array → `config.<k>: expected <type>`）
//   - properties.<k>.enum（值枚举 → `config.<k>: must be one of [...]`）
//   - type（顶层 → `config: expected <type>`）
//   - oneOf（任一分支通过即过 —— pi-default-loop 的 result.oneOf 需要；全失败 →
//     `config.<path>: no oneOf branch matched`）
//   - items（数组元素递归 → `config.<k>[i]: expected <type>`）
// 未知 schema 关键字忽略（不报错）；schema 非对象 → ["configSchema invalid"]。
// 不实现：allOf/anyOf/not/format/pattern（后续需要再加）。
import type { JsonSchema } from "../core/contracts.ts";

const ROOT_PATH = "config";

/** 校验 value 对 schema 的合规性；返回错误列表（路径含 config. 前缀，与装配器 2a 语境一致）。 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): string[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return ["configSchema invalid"];
  }
  const errors: string[] = [];
  walk(value, schema as Record<string, unknown>, ROOT_PATH, errors);
  return errors;
}

function walk(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  // type（顶层/属性级）：不匹配 → 错误；继续其余关键字（枚举/oneOf 仍可判）
  if (typeof schema.type === "string" && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}`);
  }

  // enum（值枚举；JSON 值深比较）
  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((e) => deepEqual(e, value));
    if (!ok) {
      errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
    }
  }

  // oneOf：任一分支通过即过（分支自身 0 错误）
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    let matched = false;
    for (const branch of schema.oneOf) {
      if (branch === null || typeof branch !== "object" || Array.isArray(branch)) continue;
      const branchErrors: string[] = [];
      walk(value, branch as Record<string, unknown>, path, branchErrors);
      if (branchErrors.length === 0) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      errors.push(`${path}: no oneOf branch matched`);
    }
  }

  // object：required + properties 递归
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const prop of schema.required as string[]) {
        if (typeof prop === "string" && !(prop in obj)) {
          errors.push(`${path}.${prop}: required`);
        }
      }
    }
    if (
      schema.properties !== null &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
    ) {
      for (const [prop, propSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
        if (!(prop in obj)) continue; // 缺失可选属性 → 跳过（required 已管）
        if (propSchema === null || typeof propSchema !== "object" || Array.isArray(propSchema)) continue;
        walk(obj[prop], propSchema as Record<string, unknown>, `${path}.${prop}`, errors);
      }
    }
  }

  // array：items 元素递归
  if (
    Array.isArray(value) &&
    schema.items !== null &&
    typeof schema.items === "object" &&
    !Array.isArray(schema.items)
  ) {
    const items = schema.items as Record<string, unknown>;
    for (let i = 0; i < value.length; i++) {
      walk(value[i], items, `${path}[${i}]`, errors);
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true; // 未知 type 关键字 → 忽略（不报错）
  }
}

/** JSON 值深比较（enum 用；primitive/array/object）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    return arrA.length === arrB.length && arrA.every((x, i) => deepEqual(x, arrB[i]));
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  return (
    keysA.length === keysB.length &&
    keysA.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}
