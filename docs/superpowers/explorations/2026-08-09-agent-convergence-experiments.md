# Agent 收敛实验记录（2026-08-09）

> 来源：长会话沉淀（多轮交互防"用完即弃"）——本轮所有实验结论/修复根因——后续会话/worker 可复用。
> 同步沉淀：memory `insight:agent-convergence-experiments`（worker 可查）。

## 背景

lazy 模式端到端验证中——模型"探索过度"（沉溺读信息不转实现）。本记录追踪收敛实验全过程。

## 实验 1：lazy 端到端（30 步限制）

- **指纹误判 bug**：无文件读取的 ts 程序指纹退化 `ts:*`——不同 memory 查询全判重复→误终止
- **修复**：三阶指纹（readSource 路径 / memory SQL / ts code 去空白）——回归测试 2 新
- **结论**：修复后 30 步全探索——模型无推进纪律（探索→实现转换不发生）

## 实验 2：推理内容捕获

- **发现**：deepseek 返回 `reasoning_content`——我们没提取——无法分析模型思考
- **修复**：llm-fn 提取 thinking + agent-loop llm-call 事件记录（轨迹可审计）
- **关键发现**（推理层面）：
  - 模型**有完整计划**（step 1 就规划"读索引→理解→设计→实现→测试"）
  - 模型 step 23 已说 "Now I understand the situation"——**但之后还探索 7 步**（验证与实现无关的细节）
  - **模型知道要推进——但不停——无强制 → 永远探索**

## 实验 3：PTH Worker 世界观（信息面补强）

- **参考 pi 系统提示词/AGENTS.md 功能**：身份/工作流/框架事实/约束
- **PTH_WORKER_SYSTEM**（固定注入——所有角色共享）+ memory 详细版（受保护）
- **效果**：模型知道自己在 PTH 框架（任务池/记忆共享/产物流程）——探索有序

## 实验 4：信息面补强（签名具体化）

- 能力索引签名具体化（fs/python/bash/c 确切参数/返回）
- readSource 根说明（/app/src + src/ 前缀）
- 世界观加 role-doc 查询 SQL 示例
- **效果**：签名调查从 15 步 → 0 步——但模型仍探索不转设计

## 实验 5：sandbox abort 排查（环境问题）

- **根因**：池容量 16 = 8 worker × 2 kernel 刚好占满——启动 acquire 异步竞争→部分排队 60s→
  agent 步骤内 "This operation was aborted"（间歇性）→持有者不释放→反复重试 abort 循环
- **修复**：池 16→24（余量）+ acquire 超时 60s→10s（快速失败不卡步骤）+ PTH_DEBUG_SANDBOX debug 日志
- **排查方法论**：轨迹时间戳→手动 sandbox 调用排除→复现任务（短任务+flow role）→
  /proc/<batch>/environ 确认 env→debug 日志定位 acquire 反复失败→池状态确认
- **副作用发现**：NODE_OPTIONS 被 compose 污染（PTH_DEBUG_SANDBOX 拼入）——修复

## 实验 6：放开轮数（用户决策——不划探索期）

- **决策**：不严格划分探索期（边做边找）+ 不限制推理轮数——看 worker 能推进到什么程度
- **配置**：PTH_AGENT_MAX_STEPS 30→300 + PTH_AGENT_TIMEOUT_MS 600s→10800s
- **结果（180 步轨迹）**：
  - step 1-84：边做边找（探索→积累——读源码/测试 context 操作）
  - step 84-86：★ 生成实现代码（context.ts patch——compressContext 完整设计+实现）
  - **探索→设计转换自然发生**（不需要阶段强制）——"边做边找"验证
- **剩余堵点**：① done 空 args（不会正确收尾）② fs.task 不可用

## 修复：fs.task 工作区不可用

- **根因**：task-loop 调 runAgentTask 未传 taskWorkspace→ts execute cwd=/tmp→白名单 /tasks/ 拒绝
- **修复**：task-loop 创建 /tmp/tasks/<taskId>/ + 传 runAgentTask（模型产物落盘）

## 实验 7：project-map（项目全貌——仅指针）

- **背景**：模型花大量步"摸代码库结构"（猜文件名/列目录）——无项目全貌文档
- **实现**：buildProjectMap 单源生成器（src/packages/toolstore/extensions 结构 + 职责映射）
  + 启动注入 memory kind='project-map'（受保护）+ lazy 触发指引指针（不硬加载）
- **关键**：仅指针（用户指示——不硬加载——需要时 memory.query 按需读）

## 核心结论

1. **探索→实现的转换靠"放开"不靠"限制"**：不限制轮数后模型自然转向产出（84 步探索→96 步实现）
2. **信息面补强比行为强制更有效**：签名/全貌/世界观——模型有序探索——省 20+ 步
3. **环境质量是隐藏瓶颈**：sandbox 池满 abort / fs.task 不可用——浪费步骤最多
4. **剩余待解**：done 收尾引导（模型 done 空 args——不会正确提交产物）
