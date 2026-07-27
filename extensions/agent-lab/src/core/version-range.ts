/**
 * Minimal semver-range matcher for optimizer compatibility gates.
 *
 * Supported range forms:
 *   - `*`        – matches any valid semver
 *   - `x.y.z`    – exact version match
 *   - `^x.y.z`   – caret: same major, >= specified
 *                   ^0.0.z locks patch only (>=0.0.z <0.0.(z+1))
 *                   ^0.y.z locks minor  (>=0.y.z <0.(y+1).0)
 *   - `~x.y.z`   – tilde: same major.minor, >= specified (>=x.y.z <x.(y+1).0)
 *
 * All other range forms throw RangeSyntaxError (explicit rejection, never silent mismatch).
 * Invalid / pre-release / build-metadata version strings also throw.
 */

export class RangeSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RangeSyntaxError";
  }
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a plain semver string like "1.2.3" into { major, minor, patch }.
 * Rejects pre-release tags, build metadata, leading zeros, missing parts,
 * and non-numeric components.
 */
function parseSemver(raw: string): Semver {
  // Must be exactly three dot-separated parts
  const parts = raw.split(".");
  if (parts.length !== 3) {
    throw new RangeSyntaxError(`Invalid semver: "${raw}" (expected x.y.z)`);
  }

  const [ma, mi, pa] = parts;

  // Reject if any part is empty, non-numeric, or has leading zeros (except "0")
  for (const p of [ma, mi, pa]) {
    if (!/^(0|[1-9]\d*)$/.test(p)) {
      throw new RangeSyntaxError(`Invalid semver component: "${p}" in "${raw}"`);
    }
  }

  return {
    major: Number.parseInt(ma, 10),
    minor: Number.parseInt(mi, 10),
    patch: Number.parseInt(pa, 10),
  };
}

function compare(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function semverEq(a: Semver, b: Semver): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/**
 * Check whether `version` satisfies the given `range`.
 *
 * @throws {RangeSyntaxError} if version is not a plain x.y.z semver, or if
 *         the range uses an unsupported form.
 */
export function matchesVersionRange(version: string, range: string): boolean {
  // Validate the version string first
  const ver = parseSemver(version);

  // Wildcard
  if (range === "*") {
    return true;
  }

  // Exact version
  if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(range)) {
    const r = parseSemver(range);
    return semverEq(ver, r);
  }

  // Caret: ^x.y.z
  if (range.startsWith("^")) {
    const inner = range.slice(1);
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(inner)) {
      throw new RangeSyntaxError(`Unsupported range: "${range}"`);
    }
    const r = parseSemver(inner);

    // Lower bound: ver >= r
    if (compare(ver, r) < 0) return false;

    // Upper bound depends on major
    if (r.major === 0 && r.minor === 0) {
      // ^0.0.z → <0.0.(z+1)
      return ver.major === 0 && ver.minor === 0 && ver.patch < r.patch + 1;
    }
    if (r.major === 0) {
      // ^0.y.z → <0.(y+1).0
      return ver.major === 0 && ver.minor < r.minor + 1;
    }
    // ^N.y.z (N >= 1) → <(N+1).0.0 (same major)
    return ver.major === r.major;
  }

  // Tilde: ~x.y.z
  if (range.startsWith("~")) {
    const inner = range.slice(1);
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(inner)) {
      throw new RangeSyntaxError(`Unsupported range: "${range}"`);
    }
    const r = parseSemver(inner);

    // Lower bound: ver >= r
    if (compare(ver, r) < 0) return false;

    // Upper bound: same major, < r.minor + 1
    return ver.major === r.major && ver.minor < r.minor + 1;
  }

  // Anything else is unsupported
  throw new RangeSyntaxError(`Unsupported range: "${range}"`);
}
