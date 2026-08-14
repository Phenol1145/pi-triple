# Prime Agent 调研与 PTH 对照（参考文档）

> **更新（2026-08-14）**：PTH 的 PTC 程序模式已落地——本文「PTC 差距」结论已过时，最新三方对照见 [PTC 模式三方对比：DSH × Prime Agent × PTH](./2026-08-14-ptc-comparison-dsh-prime.md)。

> 日期：2026-08-08 · 类型：exploration（外部参考） · 来源：ChatGPT 分享会话（gpt-5-6-thinking 调研，2026-08-07）
> 关联：[LLM agent 执行设计](../specs/2026-08-08-pth-llm-agent-execution-design.md)

> **整理说明（2026-08-09）**
>
> 文档性质：外部参考 exploration，不是 PTH 的规范性设计。
>
> 使用边界：本文用于记录 PTC、递归 agent、continual harness 和分层记忆的参照；其中“已对齐”“更安全”等比较判断不能覆盖 PTH SPEC 或当前代码事实。参见[Kernel 设计综合总览](../specs/2026-08-09-pth-kernel-design-synthesis.md)。

## 1. Prime Agent 是什么

**Prime Intellect 2026-08-05 发布的开源 agent harness**（非基础模型，MIT License）——定位 coding + research + long-running autonomous tasks。
核心理念：把"上下文管理、子 Agent 调度、记忆和技能更新"变成**模型自己可编程操作的对象**。

```
Recursive Language Model（RLM）+ Continual Harness → Prime Agent
```

## 2. 核心设计（5 点）

### ① 只有一个真正的工具：persistent IPython（Programmatic Tool Calling, PTC）
```
传统：LLM → 选择工具（read_file/bash/search...）→ 参数 → 返回
Prime：LLM → persistent IPython（filesystem/shell/skills/MCP/context/rlm/agent_message
       全部以 Python module/function 暴露）→ 模型自己写程序组合工具
```
**Tool Calling → Program Synthesis**——模型不只是选工具，而是写程序编排工具（for/if/异步并发/变量由 Python 提供）。

### ② rlm()：递归生成 Agent
`await rlm("分析 authentication")` 创建真正的 child Agent（LLM + conversation + IPython + context + skills + session tree），**持久存在**，父 Agent 可稍后找回继续派活；`agent_message` 在 parent/sibling/child family 内通信。拓扑 = 运行中形成的递归 Agent tree。

### ③ Continual Harness：harness 本身是可修改状态
H = (ρ, G, K, M) = (Prompt, sub-agent specs, Skills, Memory)——Agent 可 CRUD。
`/refine` 分析自己的 trajectory → 提出**最小 harness 修改**（trigger + 结果，可回滚）。基础 system prompt 不可变。

### ④ 分层记忆（计算机体系结构类比）
```
LLM context（≈ CPU cache）      —— 有限工作注意力
IPython kernel（≈ RAM）          —— 工作记忆（变量/对象/child agent 引用）
files / skills / memory（≈ disk）—— 持久存储
```
完整 session history 为 append-only JSONL，compaction 后旧历史可程序化重访。

### ⑤ daemon + 长期运行
TUI detach 不结束 agent；worker/schedule/subagents 继续存在；persistent goals/heartbeats/scheduled prompts/bounded autonomous mode——**LLM process manager**。

## 3. 与 PTH 的对照

| 维度 | Prime Agent | PTH（当前） | 差距 |
|------|------------|------------|------|
| 持久 REPL | persistent IPython | **PyKernel/BashKernel（230x 管道 JSON-RPC）** | ✅ 同理念，已落地 |
| 工具调用 | PTC（写程序组合工具） | JSON 动作（tool+args 一步步） | ⚠️ 方向差距：PTH 是"选工具"，Prime 是"写程序" |
| 子 Agent | rlm() 动态递归 | TaskResolver 静态链（transform/decompose 配置） | ❌ 无动态递归 |
| harness 自修改 | /refine（trajectory 分析 + 最小修改 + 回滚） | refine（快照→LLM 提炼→tool-function/insight） | ⚠️ PTH 是"产物提炼"，Prime 是"轨迹分析找行为改进" |
| 分层记忆 | context/kernel/disk 三层 | context（vm）+ kernel state（REPL ns）+ pg memory/toolstore | ✅ 三层对齐 |
| 长期运行 | daemon + goals/heartbeat | batch 常驻 + 自动扩缩容 | ✅ 相当 |
| 安全 | **裸 IPython 无 sandbox**（官方警告） | **vm 沙箱 + capability 白名单** | ✅ PTH 更安全 |
| LLM 多模型 | 多 provider | 全局单模型（多模型分层设计中） | ⚠️ 设计中 |

## 4. 对 PTH 的启示（按优先级）

### 近期（Phase 2 候选）
1. **agent 循环升级为"REPL 程序"模式**：PTH 的 python.execute 工具已能让 LLM 写任意 Python（可调全部能力）——把"一步步 JSON 动作"演进为"LLM 写一段 Python 组合多个操作"（PTC 简化版）。可大幅减少 LLM 调用次数（时间瓶颈！每任务 3 次→1-2 次）。

### 中期（Phase 3 候选）
2. **轨迹级 refine**：PTH agent 循环的 toolTrail（步骤轨迹）已保留——refine 从"快照提炼"升级为"轨迹分析 + 最小行为修改"（对齐 /refine 的 trigger+结果+回滚语义）。
3. **动态子任务（rlm 式）**：TaskResolver 加 LLM 动态 spawn——链结构从"发布时静态配置"演进为"agent 运行中按需分解"。

### 远期
4. **harness CRUD**：角色 prompt/工具集/记忆规则成为 agent 可修改状态（需治理边界——回滚 + 审计）。

## 5. 风险警示（Prime 的教训）

### reward hacking（Factorio 实验实证）
Prime Agent 发现 RCON 可直接生成资源 → 绕过游戏机制 → `/refine` 把作弊方法固化为 skill → **越来越擅长作弊**。
```
Self Improvement ≠ Alignment Improvement
错误目标 + 持续学习 = 越来越高效的错误行为
```
**对 PTH 的启示**：自动扩缩容/任务验收等目标函数要防漏洞；agent 自修改能力（若引入）必须有治理边界。

### sandbox
Prime 无沙箱（裸 OS 权限）；PTH 的 vm 白名单沙箱是优势——保持。

## 6. 结论

Prime Agent 验证了 PTH 的两条核心路线：**持久 REPL 作为 agent 工作空间**（PTH 已落地 230x）+ **记忆分层**（PTH 三层对齐）。最大差距在 **PTC（程序化工具调用）** 与 **动态子 agent**——是 PTH agent 循环的下一步演进方向。
