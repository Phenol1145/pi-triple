// 指针条目构造规则注册（spec §4.2，幂等）。
// EBNF 校验为行级 token：每非空行按 "|" 拆字段、对主生产式匹配；
// 指针内容每行恰一个字段（标题/摘要/源指针），`pointer = word ;` 匹配任意非空字段。
// "|" 已在 docs-source 净化为 "／"，内容不含字段分隔符。

import { AXIOM_RULE_ID, createEntry } from "../memory/entry.ts";
import type { RuleRegistry } from "../memory/rules.ts";

export const INGEST_POINTER_RULE_ID = "ingest-pointer-rule";

export function ensureIngestRule(rules: RuleRegistry): string {
  if (rules.resolveRule(INGEST_POINTER_RULE_ID)) return INGEST_POINTER_RULE_ID;
  const rule = createEntry({
    id: INGEST_POINTER_RULE_ID,
    kind: "rule",
    anchors: ["ingest.pointer"],
    content: "pointer = word ;",
    ruleRef: AXIOM_RULE_ID,
  });
  const errors = rules.registerRule(rule);
  if (errors.length > 0) throw new Error(`register ingest rule failed: ${errors.join("; ")}`);
  return INGEST_POINTER_RULE_ID;
}
