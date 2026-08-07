# 三方案异同对照（协调者汇总）

## 共同点（三份一致）
1. 拒绝 agent 自主 /refine（Factorio 教训）——固化必须过治理闸门
2. 拒绝完整 IPython/PTC 代码执行面（非 sandbox + 零新依赖）
3. 拒绝普适 rlm() 持久子会话 + daemon——任务池账本已是持久载体
4. 拒绝独立 L4 工作记忆层（但替代方案不同）
5. /refine 改造为"治理下的任务"

## 分歧对照

| 维度 | flash | pro | qwen3.8-max |
|---|---|---|---|
| C 工具面 | 批量操作表（op 白名单，判别式逐条） | 声明式 DSL（SQL 风格，原子事务）→后续评估 IPython | PTL 动词族收口（7 动词+经济闸门），第一优先级 |
| A 工作记忆 | 会话作用域 L3 草稿（TTL+session 锚点，零 schema） | 独立 L2.5 WM 表（wmSet/wmGet+TTL） | L2 scope='working' 或薄表，生命周期挂任务不挂会话 |
| B 持久会话 | session_ref 列+resumeTask（档一） | execution_context 列+/lab task resume+tracked | context_ref 指向 append-only 转录，续跑=冷读档案+常驻仅限分析者/记忆维护者 |
| D 自改进 | 观察智能层/固化治理层+三道护栏 | proposal 条目+记忆维护者触发+三方分离+审核矩阵 | refine 即任务（refine 模板+harness_changes 表+验收者分离+经济挂钩） |
| 实施顺序 | C→A→B→D | P0=A+B（WM 最急） | C 第一+E1 转录前置 |

## 最尖锐分歧
1. 顺序：pro=WM 最急 / qwen=收口最急+转录前置 / flash=C 轻量版先
2. 工作记忆落点：flash=复用 L3 草稿 / pro=独立 L2.5 / qwen=L2 扩张或薄表（后两者有弹性）
3. D 触发者：flash=agent 观察+治理固化 / pro=记忆维护者扫描 / qwen=refine 模板任务（报酬挂钩下游指标）
