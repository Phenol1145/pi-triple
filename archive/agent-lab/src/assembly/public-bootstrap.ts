import { AXIOM_RULE_ID, createEntry } from "../memory/entry.ts";
import { MemoryStore } from "../memory/store.ts";

/**
 * 公域种子（装配层 Task 3 / spec §3.2 规则链）。
 *
 * 语义：
 * - 幂等：entries/ 非空 → 跳过（空库才写；宿主初始化语义，绕过审核链——直接写内部
 *   MemoryStore，布局与 PublicDomainStore 一致：dir/entries/<id>.json + dir/index/anchors.json）
 * - tmp+rename 先写者胜：MemoryStore.write 原子写（<path>.tmp → rename）；并发宿主
 *   竞写同 id 同内容同版本 → 重落库不递增版本，先写者胜（内容一致，收敛无分叉）
 * - 种子 = 公理（id=AXIOM_RULE_ID, kind=axiom，无 ruleRef——自指豁免）+ 基础规则
 *   （kind=rule，ruleRef=公理；fact 用记忆系统测试同款 FACT_GRAMMAR EBNF 模板，
 *   experience/preference 为 word 型占位，后续领域方言扩展）
 * - 种子条目 id 约定：rule:fact / rule:experience / rule:preference（Task 4 RuleBootstrap 依赖）
 */
export class PublicDomainBootstrap {
  private dir: string; // <root>/public-domain/

  constructor(dir: string) {
    this.dir = dir;
  }

  ensureInitialized(): void {
    const store = new MemoryStore(this.dir);
    // 幂等：entries/ 非空 → 跳过（空库才写）
    if (store.listIds().length > 0) return;

    const seeds = [
      createEntry({
        id: AXIOM_RULE_ID,
        kind: "axiom",
        anchors: ["system.root"],
        content: "axiom",
        status: "official",
      }),
      createEntry({
        id: "rule:fact",
        kind: "rule",
        anchors: ["system.rules"],
        ruleRef: AXIOM_RULE_ID,
        content: [
          `fact = subject, "|", predicate, "|", object, "|", confidence, "?" ;`,
          `subject = word ;`,
          `predicate = word ;`,
          `object = word | number ;`,
          `confidence = number (* min=0 max=1 *) ;`,
        ].join("\n"),
        status: "official",
      }),
      createEntry({
        id: "rule:experience",
        kind: "rule",
        anchors: ["system.rules"],
        ruleRef: AXIOM_RULE_ID,
        // 行式 7 字段序列（与 fact 种子同构）：kind|scene|agentId|action|outcome|reward|evaluationMode
        // 对齐 economy/experience.ts experienceToLine——经验沉淀真实过 pipeline 校验（D3）。
        content: [
          `experience = kind, "|", scene, "|", agentId, "|", action, "|", outcome, "|", reward, "|", evaluationMode ;`,
          `kind = word ;`,
          `scene = word ;`,
          `agentId = word ;`,
          `action = word ;`,
          `outcome = number | "-" ;`,
          `reward = number | "-" ;`,
          `evaluationMode = word ;`,
        ].join("\n"),
        status: "official",
      }),
      createEntry({
        id: "rule:preference",
        kind: "rule",
        anchors: ["system.rules"],
        ruleRef: AXIOM_RULE_ID,
        content: "preference = word ;",
        status: "official",
      }),
    ];
    // 公理先行（ruleRef 依赖链）；MemoryStore.write 条目先、索引后（崩溃窗口 = 索引落后，rebuildIndex 修复）
    for (const entry of seeds) {
      store.write(entry);
    }
  }
}
