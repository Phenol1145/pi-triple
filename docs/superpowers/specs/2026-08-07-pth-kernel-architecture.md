# PTH kernel 架构设计（总纲）

- **日期**：2026-08-07
- **状态**：设计（brainstorming 24 项裁决定稿，待用户审阅后进入分层 spec）
- **定位**：PTH 目标架构蓝图——从"pi SDK 会话 + agent-lab 扩展"演进为"双层次分离 + 解释性语言内核 + postgres 数据世界"。
- **前序**：Prime Agent 启发 + 交叉 brainstorm panel（flash/pro/qwen3.8-max）+ 结构审计（9 scout）+ PTH kernel 草案（24 项裁决）。
- **草案**：`docs/superpowers/explorations/2026-08-07-pth-kernel-draft.md`（裁决全记录）

---

## 1. 背景与动机

### 1.1 结构审计发现（9 scout）

- **真问题①休眠代码**：assembly/taskpool-cycle/ingest-cycle/economy-market-runner 零生产引用——能力建设与运行接线脱节
- **真问题②两条 agent 构造路径**：runtime（活跃轻量）vs assembly（休眠完整）
- **真问题③execute-mode workloop 半瘫**：工具 stub + 系统会话无委托监听
- **存储 4 介质分散**：Redis（会话痕迹/设置/组件/回退/工作流/审计）+ SQLite（agent-lab.db）+ FS（记忆域/工作区/组件卷）+ 内存（ToolRegistry）
- **agent 真实执行** = pi SDK AgentSession 会话层（PTH 主路径）；agent-lab 只贡献模型选择/竞价

### 1.2 Prime Agent 启发

Prime Agent（2026-08-05）核心范式：**"只有一个工具"**——persistent IPython kernel 统一承载 skills/context/rlm()，工具调用变成程序设计（PTC）。映射到 pi-platform：**解释性语言内核**取代工具调用模式。

### 1.3 设计动机

PTH 作为**持久化 agent 集群**，需要：多语言平台协同、持久工作、弹性扩缩、统一数据。现状（工具调用 + 会话级执行 + 多介质存储）不满足——需要范式级重构。

## 2. 范式（5 条，已裁决）

| # | 范式 | 内容 |
|---|---|---|
| P1 | **双层次分离** | 用户交互 ≠ 任务执行。意图层（短命：理解意图+撰写任务）≠ 执行层（常驻：认领执行）。PTL 不必分离，PTH 必须 |
| P2 | **解释性语言交互** | LLM 与计算机的交互 = 解释性语言（非工具调用）。PTH 用；PTL 保持工具调用 |
| P3 | **记忆 = 数据；skill = 记忆的一种** | 记忆是可读写/查询/演化的数据对象；skill 是描述如何完成特定工作的数据。记忆系统/skill 库/代码库/任务统一为数据世界里的对象 |
| P4 | **LLM = 数据处理算法** | `llm.complete(messages, {model})` 可函数式调用（嵌套/链式/多模型并行）；LLM 调用流可编程 |
| P5 | **bash 也是解释型语言** | bash = 与 vm 并列的持久解释环境。"工具"概念从架构消失——解释器集合取代工具列表 |

## 3. 目标架构

```
┌─ PTH（持久化 agent 集群）────────────────────────────────────┐
│                                                              │
│  ▸ 意图层（交互/撰写——短命）                                   │
│  ├─ gateway（Fastify HTTP/SSE/WS）              [保留现状]     │
│  ├─ 用户会话 = pi SDK 轻量会话（AgentSession）                 │
│  │    理解意图 → 撰写结构化任务 → 投递任务池（不执行）           │
│  └─ 摄入（外部事件/webhook → 任务投递）          [保留 ingest]  │
│                                                              │
│  ▸ 任务池（两层唯一通道）                                      │
│  ├─ 任务六状态机（taskpool 迁 pg）                             │
│  ├─ 分选器 sorter（peek/claim/reject）                        │
│  └─ 模板 / 语义分解 / 回流 / 升级                              │
│                                                              │
│  ▸ 执行层（常驻 agent 集群——无交互）                           │
│  ├─ batch ×N（pth 容器内 spawn 子进程）                        │
│  │    └─ 每 batch = 全角色 worker 簇（每类型 ×1，v1）           │
│  │         worker = PTH kernel 实例                           │
│  │           ├─ TS 解释器（vm context，持久）                  │
│  │           ├─ bash 解释器（持久 shell 会话）                 │
│  │           ├─ Python 解释器                                 │
│  │           ├─ llm 函数（llm.complete）                       │
│  │           └─ 数据世界访问（记忆/skill/任务读写）             │
│  ├─ 任务循环：peek → claim → 执行 → submit → 转录归档          │
│  └─ 任务级工作区：认领分配 → 提交归档 → 清理                    │
│                                                              │
│  ▸ 数据世界                                                    │
│  ├─ postgres：任务池/记忆/账本/转录/审计/skill/组件元数据        │
│  ├─ Redis：会话痕迹/认证/锁/队列（交互层瞬态）                   │
│  └─ FS：任务工作区（临时）/artifacts（产物，不自动清理）/blob    │
│                                                              │
│  ▸ 基础设施                                                    │
│  ├─ model-router + ModelRuntime（pi 保留：provider 兼容）      │
│  ├─ sandbox（bash/代码执行隔离）                               │
│  └─ compose：pth + postgres + sandbox (+ dev)                 │
└──────────────────────────────────────────────────────────────┘
```

## 4. 24 项裁决汇总（约束来源）

| # | 裁决 | 内容 |
|---|---|---|
| 1 | 命名 | **PTH kernel** |
| 2 | 双层次分离 | 意图层 ≠ 执行层；PTH 必须分离 |
| 3 | 交互模式 | 解释性语言（非工具调用） |
| 4 | 记忆/skill 统一 | 记忆 = 数据；skill = 记忆一种 |
| 5 | LLM 即函数 | llm.complete 可函数式调用 |
| 6 | bash 即解释器 | bash = 与 vm 并列的持久解释环境 |
| 7 | 统一存储 | **postgres 为目标后端** |
| 8 | 会话层（方案 C，对抗性审核拆分） | **ModelRuntime/provider/model-router → 执行层 llm.complete 底层实现**；**SessionManager/eventbus → 仅意图层**（不进入执行层）；自研回合循环主体 |
| 9 | 生命周期载体 | WM 挂会话（非任务）；"WM 是机械托底的状态载体，不是思考本身" |
| 10 | C 执行语义 | 逐条判别式失败不中断（原子批 = ACID 幻觉） |
| 11 | peek 前置 | peek（只读不锁定）先于 claim/reject；"认领即承诺" |
| 12 | 经济闸门 | 缓行（只做动词族不做计费） |
| 13 | 定位 | 给 PTH 用；pi-platform 内运行 |
| 14 | 执行层形态 | batch = 进程单元；全角色 worker ×1（v1）；弹性加减 batch；动态构成留 v2。**进程边界：batch 子进程不共享父进程 pi SDK 状态；数据世界经独立 pg 连接** |
| 15 | 容器化 | 方案 C：batch = pth 内 spawn 子进程；compose 只加 postgres |
| 16 | 数据归位 | pg = 执行层真相；Redis = 交互层瞬态；FS = blob；引用而非复制 |
| 17 | 产物清理 | 不自动清理——推清理提示到交互层 |
| 18 | 工作区 | 任务级工作区（认领分配/归档/清理）；v1 整目录 rename 到 artifacts |
| 19 | 意图层 | pi SDK 轻量会话（只意图理解+任务撰写） |
| 20 | agent-lab 归位 | 选择性迁移（taskpool/sorter/ingest/memory 保留迁 pg）；**SorterCycle 降级（kernel worker 循环取代 direct-execute）；interceptor 并入 kernel llm.complete 模型路由**；废弃代码先不删 |
| 21 | 执行路径 | 全部收敛到 PTH kernel；SDK 会话仅意图层；workloop 废弃（代码保留） |
| 22 | 代码落点 | src/pth/（原生模块） |
| 23 | 语言 v1 | TS + bash + Python 三解释器（bash/Python 注入 vm context 供 LLM 代码调用） |
| 24 | 扩缩容 | 手动 + 统计建议（/lab 命令加减 batch）；自动留 v2 |
| 25 | 多租户（对抗性审核） | **v1 延续单租户**（对齐 task-pool-sorter M11）；pg 所有表加 `tenant_id TEXT NOT NULL DEFAULT 'default'` 预留；标注 v2 风险 |
| 26 | 容错模型（对抗性审核） | **watchdog/健康检查**：batch supervisor 监控 worker 子进程，crash 自动重启，重启后从 pg 恢复任务状态重新 peek；pg 断连重连；stale 回收不变量提升为架构级保证 |

## 5. 分 spec 说明

```
总纲（本文档）—— 架构蓝图
   ├─ Spec A：解释器世界（src/pth/kernel/interpreter/）
   │    TS vm 解释器 + bash 解释器 + Python 解释器 + llm 函数 + 能力注入模型
   │    解释器抽象接口（execute(program)、持久状态、数据世界访问）
   ├─ Spec B：执行层（src/pth/kernel/execution/）
   │    batch 进程管理 + worker 簇 + 任务认领循环 + 任务级工作区 + 归档
   └─ Spec C：存储（src/pth/kernel/storage/）
        postgres schema（任务/记忆/账本/转录/审计/skill）+ 数据归位
        Redis/FS 边界 + 迁移路径（agent-lab.db → pg）
```

**依赖顺序**：C（存储地基）→ A（解释器主体）→ B（执行层组装）。每层独立 TDD + SDD + 评审。

## 6. 演进路线（v1 → v2）

| 阶段 | 内容 |
|---|---|
| **v1（本设计）** | 全角色 batch（每类型×1）+ 手动扩缩容 + 任务级工作区整目录归档 + 三解释器（TS/bash/Python）+ postgres 统一存储 |
| v2 | 动态 batch 构成（开发者×2）+ 自动扩缩容（统计优化器驱动）+ 产物提炼归档（非整目录）+ 记忆检索增强 |
| 远期 | 多机部署（batch 独立容器演进）+ 向量检索 + 经济闭环 |

## 7. 非目标（YAGNI）

- ⛔ 向量检索（记忆 v1 锚点精确；schema 不预留向量字段）
- ⛔ 自动扩缩容（v1 手动 + 统计建议）
- ⛔ 动态 batch 构成（v1 全角色 ×1）
- ⛔ 多机编排（v1 单机；batch 进程与容器边界解耦为多机留路）
- ⛔ 产物自动清理（防丢失；只推提示）
- ⛔ 经济闭环/计费（经济闸门缓行）
- ⛔ 删除 agent-lab 废弃代码（保留待消化）
- ⛔ PTL 改造（PTL 保持现状：工具调用 + 本地 pi 进程）

## 8. 关键不变量

1. LLM 无状态读写头——记忆全部由数据世界/存储侧持有
2. 执行层全部收敛到 PTH kernel——无第二条执行路径
3. 意图层不执行、执行层不交互（除任务池 + 数据世界）
4. **postgres = 执行层真相源；Redis 只存交互层瞬态；FS 只存 blob。细化：组件元数据→pg（二进制留 FS）；设置→pg；认证 token 留 Redis（TTL 瞬态）；workflow 状态→pg（防 Redis 重启僵尸态）；审计→pg；会话痕迹留 Redis**
5. 引用而非复制（pg 存 taskId/artifactPath 指针）
6. 产物不自动清理（防丢失；清理提示走交互层）
7. 任务级工作区（认领分配、提交归档、清理）
8. 能力注入模型（TS context 默认空只注入白名单；bash/Python 走 sandbox 强制隔离）
9. 废弃代码不删（agent-lab 选择性迁移的剩余部分保留）
10. 零新依赖优先（v1 尽量复用 node 内置 + 现有依赖；Python 解释器除外）
11. **任务 exactly-once（对抗性审核）**：publish 持久化（入 pg 即落盘）；claim 排他（pg FOR UPDATE SKIP LOCKED）；stale 回收不中断在途执行（staleMs > executionTimeoutMs）；同一任务不可能被两 worker 同时执行
12. **迁移期双路径共存契约（对抗性审核）**：gateway 直派路径与 kernel worker 认领路径在任务池上互不干扰（claimed_by 守卫天然互斥）；共存期结束条件 = kernel v1 验收通过后 gateway 直派下线
13. **skill 双面性（对抗性审核）**：数据面（pg CRUD/版本/搜索）与执行面（注入 vm context 成为可执行模块）边界清晰；数据→代码转换在注入点发生、任务期间缓存

## 9. 相关参考

- 草案（24 项裁决全记录）：`docs/superpowers/explorations/2026-08-07-pth-kernel-draft.md`
- 结构审计：`docs/superpowers/explorations/2026-08-07-structure-recon/structure-audit.md`
- 架构梳理：`docs/superpowers/explorations/2026-08-07-structure-recon/architecture-overview.md`
- 侦察报告：`docs/superpowers/explorations/2026-08-07-structure-recon/scout-1..9-*.md`
- Prime Agent 会话：`/tmp/chatgpt-6a75a876.md`
- 交叉 brainstorm panel：`docs/superpowers/explorations/2026-08-07-prime-agent-panel/`
- 记忆系统 spec：`docs/superpowers/specs/2026-08-02-memory-system-design.md`
- 任务池+分选器 spec：`docs/superpowers/specs/2026-08-06-task-pool-sorter-design.md`
