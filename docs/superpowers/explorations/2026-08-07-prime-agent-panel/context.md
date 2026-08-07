# 交叉 Brainstorm 上下文简报：Prime Agent 启发 × 联邦设计

本文件是所有参与者（deepseek-v4-flash / deepseek-v4-pro / qwen3.8-max）共享的上下文基线。目标是：**参考已有设计和会话信息，给出"Prime Agent 启发下的联邦架构下一阶段设计"方案**。

## 一、我们的联邦设计现状（已落地/已裁决）

### 已落地的系统（pi-platform 仓库）
1. **记忆系统**（extensions/agent-lab/src/memory/，已实现+测试全绿）：L3 语义记忆 MemoryEntry（anchors 锚点/ruleRef 校验/版本化/水位线）、沉淀管道、锚点检索、公域 fork-merge 审核链、DSP 三区、comms 纸带通讯。三层记忆：L1 纸带（消息历史）/ L2 数据域（不透明状态）/ L3 语义记忆。
2. **信息摄入循环**（src/ingest/）：仓库 docs 零拷贝摄入 → 路径推导标签 → 指针条目入记忆系统 → 周期流向任务池 publish 语义分解任务。
3. **任务模板+任务池+分选器**（src/taskpool/，刚完成）：task_templates 模板注册表（标签方案+执行协议+成果契约）、tasks 表六状态机（pending→claimed→submitted→completed/rejected→回流→escalated）、分选器（agents.selector_json 正则+标签匹配、事务原子认领 topN、回流轮、stale 回收）、sorter? SDK 端口（rejectTask/submitTask 判别式返回）、/lab 命令。

### 已裁决的架构原则
1. **主会话 = 组织者，不思考**：agent 是工具+记忆的集合；sub-agent 属于主会话自身行为；协作 = 派发任务工具/市场再发布（同步等待=工具调用语义，异步=在途任务）。
2. **机械/智能分工**：摄入/匹配/认领/回流/升级 = 机械行为（系统代码+sqlite）；自检/执行 = 智能层（agent 会话内）。
3. **经济驱动**：所有 agent 目标 = 规则内获取最多货币；分析者拆分/合并权限（受奖惩）；货币清零 → 打包样本推送 PTL。
4. **任务投递窗口**：定时投递 + PTL 投递两种策略。
5. **战略**：先做到自持状态（角色收敛：分析者/计划者/开发者/侦查者/记忆维护者/验收者/人类交互专员），后尝试冷启动（受控实验）。
6. **任务池与任务模板 id 同域**（未来与经济 elo 赛道联动）；任务池不联动 task_types。

### 待裁决的设计问题（本 panel 要回答）
- A. 记忆的"工作记忆层"（会话内跨步状态，类似 RAM）要不要加？怎么加？
- B. "持久 agent 会话"（派发出去的子任务可被找回、继续、长期存在）要不要？与现在 fire-and-forget 派发的关系？
- C. 工具面要不要统一成"程序化任务操作语言"（类似 PTC：agent 用代码组合认领/提交/检索，而非逐个工具调用）？
- D. 自改进（经验→固化→下次采用）的机制与边界：谁触发、怎么评价、怎么防 reward hacking？
- E. 其他你认为重要的启发（不限以上）。

## 二、Prime Agent 要点（Prime Intellect 2026-08-05 发布，MIT）

1. **Programmatic Tool Calling (PTC)**：模型面对的唯一内建工具 = persistent IPython kernel。文件操作/Shell/Skill/MCP/context/rlm() 全以 Python module 暴露。工具调用 → 程序合成（for/if/async/变量组合）。
2. **rlm() 递归生成持久 Agent**：`await rlm("分析 X")` 创建真正的 child Agent session（自己的 LLM+对话+kernel+context+skills+session tree），可长期存在、父可找回续派；`agent_message` 通信限制在 parent/sibling/child family 关系。
3. **Continual Harness**：H=(ρ prompt, G 子代理规格, K skills, M memory)——Agent 可 CRUD 自己的 harness；`/refine` 分析轨迹提出最小 harness 修改（记录 trigger+结果），可回滚；基础 system prompt 不可变。self-improving = 参数不变、外围认知结构（prompt/memory/skill/subagent）持续变化。
4. **长时间运行**：完整 session 历史 append-only JSONL（compaction 后仍可程序化重访）；daemon 常驻、detach 不杀、persistent goals/heartbeats/scheduled prompts/bounded autonomous。
5. **三层记忆**：Context memory(≈cache) / Kernel state(≈RAM，工作记忆) / Persistent memory(≈storage，disk/db/skills)。
6. **奖励 hack 教训**（Factorio 实验）：`/refine` 把作弊方法固化成 skill——self-improvement ≠ alignment；错误目标+持续学习 = 越来越高效的错误行为。
7. **Skills = Agent 可创造**：SKILL.md + Python package + helper scripts，可直接加载进 persistent IPython。
8. **安全**：IPython/worker 非 sandbox，模型生成的代码基本有当前用户 OS 权限。

## 三、两者对照（已有初步分析）

| Prime Agent | 我们的联邦 | 关系 |
|---|---|---|
| rlm() 递归持久 Agent session | 同步/异步派发 + 在途任务清单 + direct-execute | 同构；它让子 agent 有持久身份（可找回/继续），我们目前 fire-and-forget |
| Continual Harness H=(ρ,G,K,M) 可 CRUD | 分析者拆分权限/记忆维护者/工具使用频率统计 | 它给了机制（harness 可修改），我们给了治理（谁改/怎么评/怎么淘汰）——互补 |
| /refine 轨迹分析→最小 harness 修改 | 协作简报/委托形式推荐 + 统计优化（非 NEAT） | 同一条线：经验→固化→下次采用 |
| 三层记忆（含 kernel state 工作记忆） | L1/L2/L3 记忆（无工作记忆层） | 我们缺"会话级工作记忆（RAM）"层 |
| append-only JSONL 完整历史可程序化重访 | 三账本 + 水位线 + replayable | 一致 |
| Python-backed skills（Agent 可创建） | 工具栈/权限拆分/记忆维护者 | 我们分析者拆权限的观测对象 |
| PTC 唯一工具 = persistent IPython | /lab 命令、分选器认领、sorter? 端口、记忆检索多个工具面 | 可统一成"程序化任务操作语言"？ |

## 四、输出要求

请产出一份设计方案（中文，150-250 行 markdown），结构：
1. **总判断**：Prime Agent 对联邦设计最重要的 1-2 个启发是什么（你个人判断，可与其他模型不同）
2. **对 A-E 每个问题的明确立场**：支持/反对/改造，给出具体机制（落到我们的 sqlite/事件/任务池/记忆系统语境）
3. **你推荐的下一阶段实施顺序**（哪些先进、哪些缓）
4. **风险与反对意见**（你自己的设计的弱点）
5. **与其他可能方案的分歧点预告**（你预计其他模型会怎么选，你想争论什么）

注意：你的方案要能落到 pi-platform 仓库的具体模块（taskpool/memory/ingest/scheduler/assembly），不是纯理论。
