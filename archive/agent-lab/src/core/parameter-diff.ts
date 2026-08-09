/**
 * Parameter diff utilities for optimizer round lifecycle.
 *
 * - diffLeafPaths: enumerate leaf-level paths that differ between two parameter trees.
 *   Arrays are treated as whole-leaf (no index-level descent).
 *   Non-object values on either side are defended: the path itself is reported as changed.
 * - assertPathsTunable: verify every changed path is covered by a tunable-path entry.
 *   Matching is case-sensitive, exact or `*`-segment wildcard (single segment only).
 */

export class TunablePathViolationError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(
      `untunable paths: ${violations.join(", ")}`,
    );
    this.name = "TunablePathViolationError";
    this.violations = violations;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-equal comparison for leaf values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  if (Array.isArray(a) || Array.isArray(b)) return false;

  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;

  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.hasOwn(ob, k)) return false;
    if (!deepEqual(oa[k], ob[k])) return false;
  }
  return true;
}

function diffRecurse(
  base: unknown,
  next: unknown,
  prefix: string,
): string[] {
  const baseIsObj = isPlainObject(base);
  const nextIsObj = isPlainObject(next);

  // Non-object or array on either side → treat as leaf (whole-value comparison)
  if (!baseIsObj || !nextIsObj) {
    if (!deepEqual(base, next)) {
      // Use the prefix as-is; empty prefix means root-level change
      return [prefix || ""];
    }
    return [];
  }

  // Both plain objects — recurse into keys
  const baseRec = base as Record<string, unknown>;
  const nextRec = next as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(baseRec), ...Object.keys(nextRec)]);

  const paths: string[] = [];
  for (const key of allKeys) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    const baseVal = baseRec[key];
    const nextVal = nextRec[key];
    paths.push(...diffRecurse(baseVal, nextVal, childPrefix));
  }
  return paths;
}

/**
 * Return the leaf-level paths (dot-notation) where `base` and `next` differ.
 *
 * - Plain objects are recursed into.
 * - Arrays are compared as whole values (no index-level change enumeration).
 * - If either side is not a plain object, the path is reported as a single leaf.
 * - Missing keys on either side are treated as a change at that key's path.
 */
export function diffLeafPaths(base: unknown, next: unknown): string[] {
  return diffRecurse(base, next, "");
}

/**
 * Match a single path against a tunable-path entry.
 * Case-sensitive. `*` matches exactly one segment.
 *
 * @example pathMatches("weights.completion", "weights.*") → true
 * @example pathMatches("weights.completion.sub", "weights.*") → false
 * @example pathMatches("Weights.completion", "weights.*") → false
 */
function pathMatches(path: string, tunablePath: string): boolean {
  const pathSegs = path.split(".");
  const tunableSegs = tunablePath.split(".");

  if (pathSegs.length !== tunableSegs.length) return false;

  for (let i = 0; i < pathSegs.length; i++) {
    if (tunableSegs[i] === "*") continue;
    if (tunableSegs[i] !== pathSegs[i]) return false;
  }
  return true;
}

/**
 * Assert that every path in `paths` is covered by at least one entry in `tunablePaths`.
 *
 * Matching is **case-sensitive** and supports `*` as a single-segment wildcard.
 * Throws `TunablePathViolationError` listing any violating paths.
 */
export function assertPathsTunable(
  paths: string[],
  tunablePaths: string[],
): void {
  const violations: string[] = [];
  for (const p of paths) {
    const matched = tunablePaths.some((tp) => pathMatches(p, tp));
    if (!matched) violations.push(p);
  }
  if (violations.length > 0) {
    throw new TunablePathViolationError(violations);
  }
}
