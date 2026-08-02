import { parseEbnf } from "../memory/ebnf.ts";
import { PublicDomainStore } from "../memory/public-domain.ts";
import type { CompiledRule } from "../memory/rules.ts";
import { PublicDomainBootstrap } from "./public-bootstrap.ts";

/**
 * 公域规则只读视图（装配层 Task 4 / spec §3.2 规则链）。
 *
 * 语义：
 * - resolveRule(ruleId)：读公域 kind=rule 条目（listOfficialEntries）→ parseEbnf 现场编译
 *   → 内存缓存（Map；失效 = 重建实例——无 TTL/版本探测，公域更新经重建视图生效）；
 * - 编译失败 → undefined + 记录（failed Set；不缓存失败——公域 merge 修复后可自愈重试）；
 * - 公理条目（kind=axiom）→ undefined（axiom 由 RuleRegistry.isAxiom 豁免，不参与校验链）；
 * - ensureInitialized() 委托 PublicDomainBootstrap（幂等种子）。
 */
export class RuleBootstrap {
  private pubDir: string;
  /** 编译成功缓存（失效 = 重建实例）。 */
  private cache = new Map<string, CompiledRule>();
  /** 失败记录（不存在 / 非 rule / 编译失败；观察性，不抑制重试——每次调用重新扫描公域）。 */
  private failed = new Set<string>();

  constructor(pubDir: string) {
    this.pubDir = pubDir;
  }

  resolveRule(ruleId: string): CompiledRule | undefined {
    if (this.cache.has(ruleId)) return this.cache.get(ruleId);

    // 每次未命中重新扫描公域（listOfficialEntries 读盘快照，确定性排序）；
    // 公域新增/修复的规则无需重建实例即可被后续调用发现
    const store = new PublicDomainStore(this.pubDir);
    const entry = store.listOfficialEntries().find((e) => e.id === ruleId);
    if (!entry || entry.kind !== "rule") {
      // 不存在 / 公理（kind=axiom）→ undefined（axiom 由 RuleRegistry.isAxiom 豁免）
      this.failed.add(ruleId);
      return undefined;
    }
    const result = parseEbnf(entry.content);
    if (!result.ok) {
      this.failed.add(ruleId); // 编译失败 → undefined + 记录
      return undefined;
    }
    const compiled: CompiledRule = {
      ruleId: entry.id,
      version: entry.meta.version,
      grammar: result.grammar,
      entryName: result.grammar.productions[0]?.name ?? entry.id,
      compiledAt: Date.now(),
      ebnfText: entry.content,
    };
    this.cache.set(ruleId, compiled);
    return compiled;
  }

  ensureInitialized(): void {
    new PublicDomainBootstrap(this.pubDir).ensureInitialized();
  }
}
