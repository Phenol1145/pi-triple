import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadModelScopeAllow(): string[] | undefined {
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { subagents?: { modelScope?: { enforce?: boolean; allow?: unknown } } };
    const scope = settings?.subagents?.modelScope;
    if (scope?.enforce && Array.isArray(scope.allow)) return scope.allow as string[];
    return undefined;
  } catch {
    return undefined;
  }
}

export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$", "i");
  return re.test(value);
}
function escapeRe(s: string): string { return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); }

export function modelAllowed(model: string, allowGlobs?: string[]): boolean {
  if (!allowGlobs || allowGlobs.length === 0) return true;
  return allowGlobs.some((g) => globMatch(g, model));
}
