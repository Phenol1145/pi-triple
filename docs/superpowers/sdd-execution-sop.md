# SDD 执行 SOP（经验固化——2026-08-03）

> 从 ptl-update/flow-runtime/memory-system/agent-assembly 四个子项目 + 经济层 D1 的执行经验固化。配合固化 agents：`sdd.sdd-implementer` / `sdd.sdd-reviewer` / `sdd.design-adversary`。

## 派发（implementer）

极简 prompt（5 行以内）：
```
执行 plan 的 Task N。plan: <plan 路径>（Task N 的 Interfaces 块 = 前序依赖签名）。
brief: <task-brief 生成的 brief 路径>。
前序 rulings（必须遵守）：<从 ledger 复制的未销项裁决>
```
agent systemPrompt 已固化：TDD/约束/commit 纪律/时间预算条款。

## 审查（reviewer）

1. `bash $SKILL_DIR/scripts/review-package <plan> <prev_commit> HEAD` 生成 diff
2. reviewer prompt：任务名 + brief 路径 + 报告路径 + diff 路径 + 全局约束 + 重点核对项
3. verdict：Spec ✅ + Approved → ledger 记录，下一任务；Blocker → resume implementer（fix loop，round 递增）

## 超时恢复 SOP（Task 8/10 实证）

1. **先看现场**：`cat .pi-subagents/artifacts/<id>_output.md`（partial output）+ `git status --short` + `git log --oneline -2`——判断进度（测试已写？实现多少？commit 了吗）
2. **诊断挂起**：若卡在测试运行——常见嫌疑：定时器未 unref/未 dispose、Promise 未 resolve、DB 句柄未 close
3. **resume 带诊断消息**：明确告知现场状态 + 嫌疑方向 + 修复指引（优先测试侧清理，不改已审查模块）+ 剩余步骤清单
4. implementer 已固化时间预算条款（15 分钟先 commit WIP）——超时现场应有部分 commit

## 最终 whole-branch review

1. `review-package <plan> <merge_base> HEAD`
2. 派 `sdd.design-adversary`（非主会话模型——独立视角）+ progress.md 挂起事项裁决（哪些合并前必须修）
3. REQUEST CHANGES → fix wave（单一 fix subagent 带完整 findings 清单）→ scoped re-review → APPROVE → 合并

## 协调者裁决原则

- 子代理报告的设计歧义：**不要让它自己发明语义**——协调者裁决后 resume（裁决写入 ledger 传递后续任务）
- 协调者自己犯的指令错误（如 pruneIdem 方向）：立即修正并明确标注是协调者错误（避免 implementer 困惑）
- Important 级发现：能当任务修则修，否则 ledger 记录销项路径（后续任务/最终 review/后续子项目）

## 模型策略（额度敏感）

- 实施/任务审查：deepseek-v4-flash（便宜稳定）
- 设计对抗性评审：qwen3.7-max（openrouter）→ v4-pro → v4-flash 兜底链
- 主会话模型与对抗性评审模型**必须不同**（独立视角）
