/**
 * pit-flow 图定义 schema + validate
 */

import { parseExpr } from "./expr.js";

// ── Types ─────────────────────────────────────────────────────

export interface FlowDef {
  name: string;
  entry: string;
  maxSteps?: number;
  state?: Record<string, unknown>;
  nodes: NodeDef[];
  edges: EdgeDef[];
}

export interface NodeDef {
  id: string;
  type: "agent" | "human";
  model?: string;
  tenant?: string;
  prompt?: string;
  message?: string;
  tools?: string[];
  cwd?: string;
  timeoutSec?: number;
  writes?: Record<string, string>;
}

export interface EdgeDef {
  from: string;
  to: string;
  when?: string;
}

// ── Validate ──────────────────────────────────────────────────

export function validateFlow(
  raw: unknown,
): { ok: true; def: FlowDef; warnings: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["flow must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;

  const name = requireString(obj, "name", errors);
  const entry = requireString(obj, "entry", errors);
  const nodes = requireArray(obj, "nodes", errors);
  const edges = requireArray(obj, "edges", errors);

  // maxSteps (optional, defaults to 100)
  let maxSteps = 100;
  if ("maxSteps" in obj && obj.maxSteps !== undefined) {
    if (typeof obj.maxSteps !== "number" || !Number.isInteger(obj.maxSteps) || obj.maxSteps < 1) {
      errors.push("maxSteps must be a positive integer");
    } else {
      maxSteps = obj.maxSteps as number;
    }
  }

  // state (optional)
  let state: Record<string, unknown> = {};
  if ("state" in obj && obj.state !== undefined) {
    if (typeof obj.state !== "object" || obj.state === null || Array.isArray(obj.state)) {
      errors.push("state must be an object or null");
    } else {
      state = obj.state as Record<string, unknown>;
    }
  }

  // nodes validation
  const nodeDefs: NodeDef[] = [];
  const nodeIds = new Set<string>();

  if (Array.isArray(nodes)) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || typeof n !== "object") {
        errors.push(`nodes[${i}]: must be an object`);
        continue;
      }
      const nObj = n as Record<string, unknown>;
      const id = requireString(nObj, "id", errors, `nodes[${i}]`);
      const type = requireString(nObj, "type", errors, `nodes[${i}]`);

      if (id && nodeIds.has(id)) {
        errors.push(`nodes[${i}]: duplicate id "${id}"`);
      }
      if (id) nodeIds.add(id);

      if (type && type !== "agent" && type !== "human") {
        errors.push(`nodes[${i}]: type must be "agent" or "human", got "${type}"`);
      }

      const node: NodeDef = { id: id ?? `_invalid_${i}`, type: (type as "agent" | "human") ?? "agent" };

      if (type === "agent") {
        if (!nObj.prompt) {
          errors.push(`nodes[${i}] (agent "${id || "?"}"): prompt is required`);
        } else if (typeof nObj.prompt !== "string") {
          errors.push(`nodes[${i}] (agent "${id || "?"}"): prompt must be a string`);
        } else {
          node.prompt = nObj.prompt as string;
        }

        if (nObj.model !== undefined) {
          if (typeof nObj.model !== "string") errors.push(`nodes[${i}] (agent "${id}"): model must be a string`);
          else node.model = nObj.model as string;
        }
        if (nObj.tenant !== undefined) {
          if (typeof nObj.tenant !== "string") errors.push(`nodes[${i}] (agent "${id}"): tenant must be a string`);
          else node.tenant = nObj.tenant as string;
        }
        if (nObj.tools !== undefined) {
          if (!Array.isArray(nObj.tools) || !nObj.tools.every((t: unknown) => typeof t === "string")) {
            errors.push(`nodes[${i}] (agent "${id}"): tools must be a string array`);
          } else {
            node.tools = nObj.tools as string[];
          }
        }
        if (nObj.timeoutSec !== undefined) {
          if (typeof nObj.timeoutSec !== "number" || nObj.timeoutSec < 1) {
            errors.push(`nodes[${i}] (agent "${id}"): timeoutSec must be a positive number`);
          } else {
            node.timeoutSec = nObj.timeoutSec as number;
          }
        }
      }

      if (type === "human") {
        if (!nObj.message) {
          errors.push(`nodes[${i}] (human "${id || "?"}"): message is required`);
        } else if (typeof nObj.message !== "string") {
          errors.push(`nodes[${i}] (human "${id || "?"}"): message must be a string`);
        } else {
          node.message = nObj.message as string;
        }
      }

      // cwd validation
      if (nObj.cwd !== undefined) {
        if (typeof nObj.cwd !== "string") {
          errors.push(`nodes[${i}] ("${id}"): cwd must be a string`);
        } else {
          const cwd = nObj.cwd as string;
          if (cwd.includes("..")) {
            errors.push(`nodes[${i}] ("${id}"): cwd must not contain ".."`);
          } else {
            node.cwd = cwd;
          }
        }
      }

      // writes validation
      if (nObj.writes !== undefined) {
        if (typeof nObj.writes !== "object" || nObj.writes === null || Array.isArray(nObj.writes)) {
          errors.push(`nodes[${i}] ("${id}"): writes must be an object`);
        } else {
          node.writes = nObj.writes as Record<string, string>;
        }
      }

      nodeDefs.push(node);
    }
  }

  // edges validation
  const edgeDefs: EdgeDef[] = [];
  if (Array.isArray(edges)) {
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e || typeof e !== "object") {
        errors.push(`edges[${i}]: must be an object`);
        continue;
      }
      const eObj = e as Record<string, unknown>;
      const from = requireString(eObj, "from", errors, `edges[${i}]`);
      const to = requireString(eObj, "to", errors, `edges[${i}]`);

      const edge: EdgeDef = { from: from ?? `_invalid_from_${i}`, to: to ?? `_invalid_to_${i}` };

      if (eObj.when !== undefined) {
        if (typeof eObj.when !== "string") {
          errors.push(`edges[${i}]: when must be a string`);
        } else {
          edge.when = eObj.when as string;
          // 静态解析校验
          const parsed = parseExpr(edge.when);
          if (!parsed.ok) {
            errors.push(`edges[${i}]: when expression parse error — ${parsed.error}`);
          }
        }
      }

      edgeDefs.push(edge);
    }
  }

  // 引用完整性
  const allRefs = new Set(nodeDefs.map((n) => n.id));
  allRefs.add("end"); // "end" is a special valid target

  if (entry && !allRefs.has(entry)) {
    errors.push(`entry "${entry}" does not reference a valid node`);
  }

  for (let i = 0; i < edgeDefs.length; i++) {
    const e = edgeDefs[i];
    if (e.from && !allRefs.has(e.from)) {
      errors.push(`edges[${i}]: from "${e.from}" does not reference a valid node`);
    }
    if (e.to && !allRefs.has(e.to)) {
      errors.push(`edges[${i}]: to "${e.to}" does not reference a valid node`);
    }
  }

  // 不可达节点检测（仅 warning）
  if (errors.length === 0 && entry) {
    const reachable = new Set<string>();
    function walk(id: string) {
      if (reachable.has(id)) return;
      reachable.add(id);
      if (id === "end") return;
      for (const e of edgeDefs) {
        if (e.from === id) walk(e.to);
      }
    }
    walk(entry);
    for (const n of nodeDefs) {
      if (!reachable.has(n.id)) {
        warnings.push(`node "${n.id}" is not reachable from entry`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    def: { name: name!, entry: entry!, maxSteps, state, nodes: nodeDefs, edges: edgeDefs },
    warnings,
  };
}

// ── Helpers ───────────────────────────────────────────────────

function requireString(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  prefix = "",
): string | null {
  const label = prefix ? `${prefix}.${key}` : key;
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
    errors.push(`${label}: required`);
    return null;
  }
  if (typeof obj[key] !== "string") {
    errors.push(`${label}: must be a string, got ${typeof obj[key]}`);
    return null;
  }
  return obj[key] as string;
}

function requireArray(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
): unknown[] | null {
  if (!(key in obj) || obj[key] === undefined) {
    errors.push(`${key}: required`);
    return null;
  }
  if (!Array.isArray(obj[key])) {
    errors.push(`${key}: must be an array`);
    return null;
  }
  return obj[key] as unknown[];
}
