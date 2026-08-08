# 任务池执行体系优化任务——实验现象记录

> 日期：2026-08-08 · 类型：exploration · 关联：[任务链 SPEC](../specs/2026-08-08-pth-task-resolver-design.md) · [REPL SPEC](../specs/2026-08-08-pth-multilang-repl-design.md)

## 背景

PG 专项优化启动前盘点：PTH 试运行环境的 PostgreSQL 全部为默认参数（shared_buffers=128MB / work_mem=4MB / max_connections=100 / jit=on），tasks 表 78 行 17MB（30x 膨胀）。
实验意图：把"体系优化"类任务投进 PTH 任务池，观察任务池会如何处理（角色路由/执行能力/知识沉淀）。

## 实验过程

### 1. 角色盘点（DEFAULT_ROLES 7 个，无专职优化角色）

| 角色 | labelPatterns | 定位 |
|------|--------------|------|
| analyst | analysis/research | 分析者 |
| planner | plan/design | 计划者 |
| developer | implement/code/fix | 开发者 |
| scout | recon/investigate | 侦查者 |
| memory-keeper | memory/organize | 记忆维护者 |
| acceptor | accept/verify | 验收者 |
| human-interface | human/interact | 人类交互者 |

**结论：无 optimize/maintain/ops 语义角色。**

### 2. 投递（代码形态任务）

```json
{
  "title": "体系优化：PG tasks 表膨胀回收（VACUUM FULL）",
  "text": "bash.execute(\"docker exec pth-trial-pg psql ... VACUUM FULL tasks ...\")",
  "tags": ["optimize", "pg", "maintenance"]
}
```

### 3. 观察结果

| 环节 | 结果 |
|------|------|
| **认领角色** | ⚠️ **acceptor（验收者）**——不是 developer；v1 机械认领先到先得，不按标签/语义匹配 |
| **执行** | 任务代码经 bash 通道 → docker exec → psql，**VACUUM FULL 真实执行成功** |
| **实际效果** | tasks 表 **17MB → 2.8MB（87% 膨胀回收）** |
| **部分失败** | 后两条 `pg_table_size("tasks")` 双引号被 psql 解析为列名 → ERROR（任务代码转义脆弱） |
| **refine** | 提炼 0 函数 0 经验（bash 输出型任务无顶层声明——预期内） |
| **耗时** | 投递 → completed 3s |

## 暴露的差距

| # | 差距 | 说明 |
|---|------|------|
| 1 | **无专职优化角色** | 7 角色均无 optimize 语义；加 optimizer 角色容易，但 v1 机械认领下只是多一个抢任务的 |
| 2 | **任务路由粗糙** | acceptor 抢优化任务纯属竞速；candidates 返回全部 pending 不按标签过滤 |
| 3 | **任务代码脆弱** | docker/psql 命令嵌套转义易错（本实验后两条查询失败） |

## 演进建议（bootstrap 到后续问题）

```
近期（低成本）：
  - 加 optimizer 角色（labelPatterns: optimize/maintain/tune/ops）
  - candidates 按 tags 匹配角色 labelPatterns（v2 标签过滤）
中期：
  - assess 智能路由（LLM 自检候选可完成性——Spec B 预留）
远期：
  - 自然语言任务支持（当前 text 需代码形态；转义脆弱源于此）
```

## 附：PG 现状基线（调优前）

| 项 | 值 |
|----|----|
| 服务器参数 | 全默认（boot_val == setting） |
| 连接池 | 每 batch 独立 pool max=10 → N batch = N×10，15-20 batch 触顶 100 |
| tasks 表 | 17MB / 78 行（VACUUM FULL 后 2.8MB） |
| transcripts 表 | 20MB / 5490 行 |
| 索引 | candidates/claim 场景已有覆盖（idx_tasks_status/created/claimed_by/tags-gin） |
