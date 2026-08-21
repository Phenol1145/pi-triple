# Hermes Agent × Prime Agent 记忆与 Skill 进化结构参考（PTH 对照）

> 日期：2026-08-14 · 类型：exploration（外部参考）· 来源：agent-reach（Exa 搜索 + Jina Reader 读 hermes-agent.nousresearch.com 官方文档 + GitHub repo）+ 本仓 2026-08-08 Prime Agent 参考文档
> 关联：[B4 skill 记忆类型方案](../../pth/backlog-priority.md)、[PTC 模式三方对比](./2026-08-14-ptc-comparison-dsh-prime.md)
> **性质说明**：外部参考 exploration，不是 PTH 的规范性设计。「可借鉴」条目为候选方向，落地须走概念先行（concepts.md 词表/原则更新）+ 用户裁决。

## 1. 为什么参考这两个

- **Prime Agent（多级记忆）**：计算机体系结构类比的三层记忆（context≈cache / IPython kernel≈RAM / disk 持久层）——本仓 2026-08-08 参考文档已对齐三层；本批补读其「记忆是可编程操作对象」与 append-only 轨迹两点的 B4 映射。
- **Hermes Agent（记忆与 skill 的稳定进化结构）**：Nous Research 开源自改进 agent——唯一带内建学习闭环的 agent：「从经验创建 skill、使用中自我改进、nudge 自己沉淀知识、跨会话搜索自己的历史」——正是 N2（skill 一等化）要设计的「稳定进化结构」的直接参照。

## 2. Hermes 记忆与 skill 结构（官方文档事实）

### 2.1 记忆 = 有界精选（bounded, curated）

| 机制 | Hermes 事实 | 要点 |
|---|---|---|
| 容量硬上限 | MEMORY.md 2200 字符 / USER.md 1375 字符 | 焦点靠硬界——不是越多越好 |
| **不自动压缩** | 超限时 memory 工具**报错**，agent 自己 consolidate/remove 后重试 | 记忆管理是模型自己的职责——不静默丢弃 |
| **冻结快照** | 会话开始渲染进 system prompt 后**冻结**（保 prefix cache）；会话内变更落盘但下会话生效；工具响应显示 live 状态 | 前缀缓存友好——写后不扰动正在跑的上下文 |
| 自动保存 | 「学到东西时」自动写 | 沉淀触发=学习事件 |
| 写审批门 | memory.write_approval：staged（pending 目录存续跨重启）→ approve/deny | 可选人工闸门 |

### 2.2 skill = 程序性记忆（procedural memory）

**与记忆的分工**（原话）：「memory 存**常驻上下文的小事实**；skill 存**只在相关时加载的长程序**」——声明性 vs 程序性的两层分工。

| 机制 | Hermes 事实 | 要点 |
|---|---|---|
| 渐进披露 | Level 0 清单（name+description，~3k tokens）→ Level 1 全文 → Level 2 引用文件 | 只在实际需要时付 token |
| SKILL.md 格式 | frontmatter（name/description/version）+ **When to Use** + **Procedure** + **Pitfalls** + **Verification** | 四段式：触发条件/步骤/**已知失败模式**/**怎么确认成功** |
| 创建时机 | 复杂任务成功后（5+ tool calls）/踩坑找到正路/用户纠正后/发现非平凡工作流 | **从经验固化**——与 PTH refine 洞察同源 |
| 自我改进 | skill_manage 工具：create/**patch（优先——token 高效）**/edit/delete | patch 优于全量 edit |
| 后台评审 | 会话后 background review 可 suggest/stage skill 改动 | 改进不是即时写死——先提案 |
| 写审批门 | skills.write_approval：staged → /skills pending/diff/approve/reject | 与 PTH T7 归档 approve 流同构 |
| 生态面 | agentskills.io 开放标准 + Skills Hub 多源（official/skills.sh/well-known/url/github）+ quarantine 安全扫描 | 0.13 外部 skill 映射的现成形态 |

## 3. Prime 多级记忆补充映射（本批新读）

| Prime 事实 | PTH 映射（现状） |
|---|---|
| 分层记忆：context（cache）/ kernel（RAM）/ disk | ✅ 已对齐：vm context / REPL 持久 ns / PG memory+toolstore |
| 记忆/技能是**模型可编程操作的对象**（harness CRUD） | 部分：refine 提炼 insight；skill 维护面（B4）即此 |
| append-only 完整 session JSONL + compaction 后程序化重访 | ✅ transcripts body JSONB append-only + context-compaction 产物（N6 复测也依赖轨迹） |
| **reward hacking 实证**：错误目标 + 持续学习 = 越来越高效的错误行为（作弊固化为 skill） | PTH 防线：负结果收敛/审批面/B4 的不可变+memory-keeper 专项+人工闸门——作弊固化必须过维护任务与闸门 |

## 4. 对 B4 的可借鉴清单（候选——非规范性）

1. **skill 格式四段式**（Hermes）：现有三要素（场景锚点/何时用/效果）+ 步骤，**补两段——Pitfalls（已知失败模式与修正）与 Verification（怎么确认成功）**。Pitfalls 是「负知识」的结构化落点（与 PTH 负结果收敛同源）；Verification 让 SOP 自验证（与 N6 复测思想同构——但按用户裁决，skill 不做自动复测，Verification 是给人/维护者看的验收标准）。
2. **渐进披露两级检索**（Hermes Level 0/1）：skill 清单（name+description 摘要——memory.index 或 role 指引注入）+ 按需全文（memory.query id 查）——B4-3 从「仅指针」升级为「清单+按需」两级（外部证据：~3k tokens 清单 vs 全文按需）。
3. **有界记忆**（Hermes）：skill 条目内容长度上限（建议 4KB）+ 超限**报错不静默截断**（维护者自己精简/拆分——与 Hermes「不自动压缩」同义）。
4. **创建时机**（Hermes）：复杂任务成功/踩坑正路/用户纠正 → refine insight 已捕捉 → **memory-keeper 维护任务固化**为 skill——维护任务流承接（用户裁决的专项维护）。
5. **staged 审批流**（Hermes write_approval）：skill 维护写走 draft 提案 → 监督批准 → memory-keeper 执行（与 T7 归档 approve 流同构——复用 manage 通道）。
6. **冻结快照友好**（Hermes）：skill 不进 system prompt（lazy 按需查）——天然不破坏 prefix cache；这正是 B4「不可变 + 懒加载」的组合论据。
7. **reward hacking 防线映射**（Prime 警示）：skill 固化错误行为是 Prime 的实证风险——PTH 的不可变+专项维护+审批面正是防线；补一条：维护任务产出的 skill 必须过 Pitfalls/Verification 段（负知识显式化）。

## 5. 结论

- Hermes 验证了 PTH B4 的**核心分工**：声明性小事实（rule——常驻上下文）vs 程序性长程序（skill——按需加载）——与已裁决的 rule/skill 分界同构；
- Hermes 的**稳定进化结构** = 有界 + 冻结快照 + 渐进披露 + staged 审批 + 从经验固化的创建时机——B4 的可借鉴增量是 **Pitfalls/Verification 两段 + 清单两级检索 + 内容上限 + staged 审批流**；
- Prime 的多级记忆 PTH 已三层对齐；其 reward hacking 警示强化了 B4 的治理裁决（不可变 + memory-keeper 专项 + 人工闸门）的正确性。
