/**
 * container-runtime/version-constraint.ts —— 最小化语义化版本约束。
 *
 * 约束语法（fail-closed，只支持显式操作符）：
 *   * | >=x.y.z | >x.y.z | <=x.y.z | <x.y.z | =x.y.z
 * 版本允许前导 "v"，允许 `-pre`/`+build` 后缀（比较只取 major.minor.patch）。
 */

const CONSTRAINT_RE = /^(\*|(>=|<=|>|<|=)\s*[vV]?(\d+)\.(\d+)\.(\d+))$/;
const VERSION_RE = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export type VersionConstraintOperator = ">=" | ">" | "<=" | "<" | "=";

export interface ParsedVersionConstraint {
  readonly operator: VersionConstraintOperator;
  readonly parts: readonly [number, number, number];
}

export function isVersionConstraint(value: unknown): value is string {
  return typeof value === "string" && CONSTRAINT_RE.test(value.trim());
}

export function parseVersionConstraint(value: string): ParsedVersionConstraint | null {
  const match = CONSTRAINT_RE.exec(value.trim());
  if (!match) return null;
  if (match[1] === "*") {
    return { operator: "=", parts: [0, 0, 0] };
  }
  return {
    operator: match[2] as VersionConstraintOperator,
    parts: [Number(match[3]), Number(match[4]), Number(match[5])],
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  if (!pa || !pb) return Number.NaN;
  for (let i = 0; i < 3; i += 1) {
    const diff = pa[i]! - pb[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

export function satisfiesVersionConstraint(version: string, constraint: string): boolean {
  const parsed = parseVersionConstraint(constraint);
  if (!parsed) return false;
  if (constraint.trim() === "*") return parseSemverParts(version) !== null;
  const target = parsed.parts.join(".");
  const diff = compareSemver(version, target);
  if (Number.isNaN(diff)) return false;
  switch (parsed.operator) {
    case ">=": return diff >= 0;
    case ">": return diff > 0;
    case "<=": return diff <= 0;
    case "<": return diff < 0;
    case "=": return diff === 0;
  }
}

function parseSemverParts(version: string): [number, number, number] | null {
  const match = VERSION_RE.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
