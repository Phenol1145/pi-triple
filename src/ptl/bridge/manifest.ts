/**
 * bridge/manifest.ts — agent.json 校验器
 *
 * 校验 agent 程序清单，返回 ProgramManifest 或错误列表。
 * 手写校验，零外部依赖。
 */

/** agent 程序 manifest（agent.json 合法内容） */
export interface ProgramManifest {
  name: string;
  description?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  systemPrompt?: string;
  skills?: string[];
  tools?: string[];
  excludeTools?: string[];
  input?: {
    schema?: Record<string, unknown>;
  };
  timeoutSec?: number;
}

/** 校验结果 */
export interface ManifestResult {
  ok: true;
  manifest: ProgramManifest;
}
export interface ManifestError {
  ok: false;
  errors: string[];
}

/** name 正则：^[a-z0-9][a-z0-9-]{0,62}$ */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** 允许的工具名（非空字母数字 + 下划线/连字符） */
const TOOL_RE = /^[a-zA-Z0-9_-]+$/;

/** 禁止路径穿越的字符 */
const DANGEROUS_PATH = /(?:^\.\.(?:\/|$)|(?:\/|^)\.\.$|(?:\/\.\.\/))/;

export function validateManifest(raw: unknown): ManifestResult | ManifestError {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["agent.json 必须是 JSON 对象"] };
  }

  const m = raw as Record<string, unknown>;

  // name（必需，正则）
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    errors.push("name 必需且格式为 a-z0-9 + 连字符（1~63 字符，首位字母或数字）");
  }

  // description（可选）
  if (m.description !== undefined && typeof m.description !== "string") {
    errors.push("description 必须是字符串");
  }

  // model/provider/thinking（可选字符串）
  for (const f of ["model", "provider", "thinking"]) {
    if (m[f] !== undefined && typeof m[f] !== "string") {
      errors.push(`${f} 必须是字符串`);
    }
  }

  // systemPrompt（可选，路径禁 `..`）
  if (m.systemPrompt !== undefined) {
    if (typeof m.systemPrompt !== "string") {
      errors.push("systemPrompt 必须是相对路径字符串");
    } else if (DANGEROUS_PATH.test(m.systemPrompt)) {
      errors.push(`systemPrompt 路径不得包含 ".."`);
    }
  }

  // skills（可选，字符串数组，路径禁 `..`）
  if (m.skills !== undefined) {
    if (!Array.isArray(m.skills) || !m.skills.every((s) => typeof s === "string")) {
      errors.push("skills 必须是字符串数组");
    } else {
      for (let i = 0; i < m.skills.length; i++) {
        if (DANGEROUS_PATH.test(m.skills[i] as string)) {
          errors.push(`skills[${i}] 路径不得包含 ".."`);
          break;
        }
      }
    }
  }

  // tools/excludeTools（可选，字符串数组）
  for (const f of ["tools", "excludeTools"]) {
    if (m[f] !== undefined) {
      if (!Array.isArray(m[f]) || !(m[f] as any[]).every((s) => typeof s === "string")) {
        errors.push(`${f} 必须是字符串数组`);
      } else {
        for (let i = 0; i < (m[f] as string[]).length; i++) {
          if (!TOOL_RE.test((m[f] as string[])[i]!)) {
            errors.push(`${f}[${i}] 包含非法字符`);
            break;
          }
        }
      }
    }
  }

  // input
  if (m.input !== undefined) {
    if (typeof m.input !== "object" || m.input === null || Array.isArray(m.input)) {
      errors.push("input 必须是对象");
    }
  }

  // timeoutSec（可选，1-3600 整数）
  if (m.timeoutSec !== undefined) {
    if (typeof m.timeoutSec !== "number" || !Number.isFinite(m.timeoutSec) || m.timeoutSec < 1 || m.timeoutSec > 3600) {
      errors.push("timeoutSec 必须是 1-3600 的整数");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    manifest: {
      name: m.name as string,
      description: m.description as string | undefined,
      model: m.model as string | undefined,
      provider: m.provider as string | undefined,
      thinking: m.thinking as string | undefined,
      systemPrompt: m.systemPrompt as string | undefined,
      skills: m.skills as string[] | undefined,
      tools: m.tools as string[] | undefined,
      excludeTools: m.excludeTools as string[] | undefined,
      input: m.input as { schema?: Record<string, unknown> } | undefined,
      timeoutSec: m.timeoutSec as number | undefined,
    },
  };
}
