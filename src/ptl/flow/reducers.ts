/**
 * pit-flow v2 — reducers + state field parsing
 */

export type Reducer = "last-wins" | "append" | "concat";

export interface StateFieldDef {
  initial: unknown;
  reducer: Reducer;
}

/** 解析 state 字段：裸值视为 last-wins 简写（v1 兼容） */
export function parseStateField(raw: unknown): StateFieldDef {
  if (raw === null || raw === undefined) {
    return { initial: undefined, reducer: "last-wins" };
  }
  if (typeof raw === "object" && !Array.isArray(raw) && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const initial = "initial" in obj ? obj.initial : undefined;
    const reducer = ("reducer" in obj && typeof obj.reducer === "string")
      ? obj.reducer as Reducer
      : "last-wins";
    if (reducer !== "last-wins" && reducer !== "append" && reducer !== "concat") {
      // Unknown reducer → default to last-wins
      return { initial, reducer: "last-wins" };
    }
    return { initial, reducer };
  }
  // Bare value (string, number, boolean, array) → last-wins
  return { initial: raw, reducer: "last-wins" };
}

/** 波合并时应用 reducer */
export function applyReducer(
  reducer: Reducer,
  current: unknown,
  additions: Array<{ node: string; value: unknown }>,
): unknown {
  if (additions.length === 0) return current;

  // Sort by nodeId for determinism
  const sorted = [...additions].sort((a, b) => a.node.localeCompare(b.node));

  switch (reducer) {
    case "last-wins": {
      // Single writer: straight value; multi-writer: last by nodeId order
      const last = sorted[sorted.length - 1];
      return last ? last.value : current;
    }
    case "append": {
      const arr = Array.isArray(current) ? [...current] : [];
      for (const a of sorted) {
        arr.push({ node: a.node, value: a.value });
      }
      return arr;
    }
    case "concat": {
      const parts: string[] = [];
      if (typeof current === "string" && current.length > 0) {
        parts.push(current);
      }
      for (const a of sorted) {
        const str = a.value === null || a.value === undefined ? "" : String(a.value);
        if (str.length > 0) parts.push(str);
      }
      return parts.join("\n\n---\n\n");
    }
    default:
      return current;
  }
}

/** 有效的 reducer 值集合 */
export const VALID_REDUCERS = new Set<string>(["last-wins", "append", "concat"]);
