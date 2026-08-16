<p align="center">
  <img src="docs/images/pi-triple-banner.svg" alt="Pi-Triple" width="320">
</p>

<p align="center">
  <a href="https://img.shields.io/badge/version-1.1.0-blue"><img alt="version" src="https://img.shields.io/badge/version-1.1.0-blue?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/tests-1897%20passed-green"><img alt="tests" src="https://img.shields.io/badge/tests-1897%20passed-green?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/node-%3E%3D22-green"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D22-green?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/typescript-5.7-blue"><img alt="ts" src="https://img.shields.io/badge/typescript-5.7-blue?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/license-MIT-green"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" /></a>
</p>

<p align="center">
  <strong>基于 <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent">pi SDK</a> 的两个独立产品——多环境共存平台（PTL）+ 自耦自然语言解释器（PTH）。PTL 可通过 PTH CLI 调用 PTH。</strong>
</p>

<p align="center">
  <a href="docs/README.md">📖 文档中心</a>
  ·
  <a href="#-quick-start">🚀 Quick Start</a>
  ·
  <a href="ARCHITECTURE.md">🏗️ 架构</a>
  ·
  <a href="#-roadmap">🗺️ Roadmap</a>
  ·
  <a href="docs/pth/kernel.md">⚙️ PTH Kernel</a>
  ·
  <a href="#-license">📄 License</a>
</p>

---

## What is Pi-Triple?

Pi-Triple 是跑在 pi SDK 之上的两个独立产品：**PTL** 是基于 pi 的多环境共存平台（CLI + TUI + tmux），**PTH** 是自耦自然语言解释器（解释即执行）。二者不存在前后端关系，PTL 可通过 PTH CLI 调用 PTH。

| | PTL（Pi-Triple-Lite） | PTH（Pi-Triple-Heavy） |
|---|----------------------|------------------------|
| **定位** | 基于 pi 的多环境共存平台 | 自耦自然语言解释器（解释即执行） |
| **入口** | `ptl` CLI | `pth` CLI（`pth submit/status/wait`） |
| **运行时** | pi 进程 × tmux | AgentEngine + Redis + BullMQ + PostgreSQL |
| **适用** | 多 pi 环境并行共存 · 交互式调试 | 自然语言解释执行 · CLI/程序化调用 |
| **源码** | `packages/framework/` | `src/pth/` |
| **文档** | [PTL 架构](./docs/ptl/architecture.md) | [PTH 架构](./docs/pth/architecture.md) · [Kernel 体系](./docs/pth/kernel.md) |

```text
PTL（多环境共存平台）        PTH（自耦自然语言解释器）
─────────────────          ──────────────────────────────
ptl tui/CLI            →     pth CLI（submit/status/wait）
ptl tui dashboard      →     Gateway（HTTP/SSE 兼容通道）
（旧 ptl hub HTTP 桥兼容）→     AgentEngine
                          →     Kernel 任务内核（解释即执行的内部机制）
```

> 🔧 **SDK 兼容性**：所有 pi SDK 调用通过 `packages/infra/src/sdk-adapter/` 适配层隔离，升级 SDK 只改适配层。当前适配 `@earendil-works/pi-coding-agent@^0.82.1`。

---

## ✨ Quick Start

### PTL：30 秒上手

```bash
# 前置：Node >= 22，至少配置一个 LLM API key（ptl onboard 会检查）
git clone https://github.com/Phenol1145/pi-triple.git && cd pi-triple
npm install && npm run build && npm link   # ★ 必须先 build：ptl bin 跑 packages/framework/dist/

ptl onboard          # 环境导引（检查 + 初始化配置/模板/共享扩展）
ptl template new dev # 新建一个工作模板（默认模板别名 local 已存在）
ptl start            # tmux 会话，立即接入
ptl tui dashboard    # 系统总控 TUI
```

### PTH：自然语言解释器试运行

```bash
# 先构建 dist（见上方 Quick Start 或 Development 节），再启动
# 独立 postgres/redis 见 docs/pth/deployment.md
DATABASE_URL=... REDIS_URL=... PORT=33100 node dist/pth/main.js

# 发布任务 + 启动 worker
curl -X POST http://localhost:33100/api/v1/kernel/tasks \
  -d '{"title":"demo","text":"return {sum:[1,2,3].reduce((a,b)=>a+b)}","createdBy":"demo","tags":["demo"]}' \
  -H "Authorization: Bearer <token>"
ptl hub kernel batch add 2     # 启动 2 个 worker

# 可观测
curl http://localhost:33100/metrics   # Prometheus 四层指标
```

---

## What Pi-Triple can do

### PTL

- **双 Ink TUI**：`ptl tui dashboard` 系统总控 / `ptl tui lab` 模型调试（遥测 SQLite）
- **tmux 多会话管理**：`ptl start --bg --name coding` 后台启动，`attach/switch` 瞬移切换
- **共享扩展层**：bundled 扩展 symlink 注入各模板，一处更新全局可见
- **PTL→PTH 桥**：`ptl hub submit/run` — agent 程序打包提交到 PTH 运行

### PTH Kernel（任务内核）

| 能力 | 说明 | 实测 |
|------|------|------|
| **多语言持久 REPL** | PyKernel 管道 JSON-RPC / BashKernel 持久 shell / TS VM 沙箱（能力白名单） | Python 执行 **230x**（0.12ms vs spawn 12ms） |
| **编译核** | C 首发（gcc/clang/tcc 变体）：编译-运行管道 + **持久缓存**（跨调用/跨容器重启——同代码 ~1ms 命中）+ 命名编译单元（c.saveUnit/executeUnit——跨任务复用 + 增量重算） | 缓存恢复端到端验证（cacheHits 3/coldCompiles 0） |
| **调试核** | gdb MI 全链路（断点/单步/栈/变量/求值——sandbox 端点生产可用）+ 异步停止模型 | 端到端：breakpoint-hit bkptno=1 frame args x=14 → evaluate x+1=15 |
| **Batch 架构** | **单大 batch 默认**（启动即全量构成——node 基线不重复省 40% 内存）+ **worker 级控制**（pause/resume/remove/add——进程内启停）+ **资源分配策略接口**（balanced/reinforced + 注册表可扩展） | 端到端：remove→pending/add→completed/pause 隔离其他角色 |
| **自动调度** | descheduler 思想（PTH_AUTOSCALE_MODE=balanced|reinforced——per-role 队列积压自动强化 batch） | reinforced：角色积压超阈值自动 spawn 强化 |
| **调试协议** | gdb MI 解析器 + CDebugSession（断点/单步/栈/变量/求值）+ 四级回退链（L0 gdb → L2 bash 核 strace/valgrind） | 容器内断点命中契约验证（breakpoint-hit + frame args） |
| **标准扩展包** | memory/context/model/perf/obs 五成员（ts 核内能力对象）+ 配置中心（env 快照 + 运行时 SET）+ 策略闭环（publish/apply）+ obs IPC 请求通道 | 端到端：LLM 用 obs 调查发现系统 bug 并报告 |
| **任务池** | 发布（代码形态）→ 认领 → 执行 → submit/reject 闭环，多 worker batch | 语法错误任务按 reject 处理（不误标 completed） |
| **Kernel Sandbox** | REPL kernel 池落独立容器（internal 网络零出口 + 零业务密钥 + Bearer 认证 + 非 root + 资源限额） | SUM5050=5050 端到端；os.environ 仅共享密钥 |
| **记忆闭环** | 任务完成 → LLM 提炼 → tool-function 源码+spec / 洞察 双通道持久化 → 状态召回 | fibonacci → refine → fib(20)=6765 跨任务复用 |
| **任务链** | `payload.flow` 自带路由（transform/decompose/branch/loop/wait/terminal）+ 递归注销 | developer → 自动生成验收任务 → 双 completed |
| **工具文件通道** | `fs.readText/list`（toolstore）——LLM 自主 import 工具文件 | fact(10)=3628800 端到端 |
| **监控** | 四层 35+ 指标（L0 基建/L1 kernel/L2 任务/L3 产出）+ `/metrics` + ResourceProvider 跨 OS | cpu/rss/llm tokens/kernel exec/refine 全可查 |
| **日志** | KernelLogger（JSON 默认，taskId/role/batchPid 链路 ctx，batch IPC 转发） | 全链路下钻 |

### 平台

- **统一 provider 后端**：pit-providers 声明式 JSON + 多 Key failover（401/403 自动切换）
- **跨会话通信**：mailbox 文件邮箱 + manual/auto/hybrid 审核 + 不可变审计日志
- **凭据单一出口**：`resolveSdkConfigPaths()`（PTL/PTH 同源，异机/容器不分叉）

---

## 🏗️ Architecture

```text
PTL                         PTH
─────                       ──────────────────────────────────
packages/framework/         src/pth/
  cli/ 命令模块               gateway/   Fastify + auth + SSE
  bridge/ PTL→PTH 桥          core/      AgentEngine · SessionPool
  lab-data/ 遥测 SQLite       programs/  ProgramStore（桥服务端）
  tui-ptl/ tui-lab/           kernel/    ★★ 任务内核
packages/shared/                       execution（TaskLoop·Batch·Resolver·Refiner）
  config · tmux · presence             interpreter（PyKernel·BashKernel·TS VM·toolstore）
packages/infra/                        storage（PostgreSQL：tasks/memory/transcripts）
  sdk-adapter · model-router           observability（四层指标 + ResourceProvider）
  sdk-paths.ts ★ 凭据唯一出口
```

**扩展生态（5 个 bundled）**：pit-providers · mailbox · pit-control · pth-tasks · extensions-in-container（workflow/agent-lab 已归档至 archive/）

**技术栈**：Node ≥22 · TypeScript 5.7 · pi SDK 0.82 · React+Ink · tmux · Fastify 5 · ioredis+BullMQ · **PostgreSQL** · pino · prom-client · vitest

详见 [ARCHITECTURE.md](./ARCHITECTURE.md)（单一真相源）· [PTH Kernel 体系](./docs/pth/kernel.md) · [API 参考](./docs/pth/api.md) · [部署指南](./docs/pth/deployment.md)

---

## 🧭 Design Philosophy

| 原则 | 说明 |
|------|------|
| **pi 是引擎，平台是壳** | 不重写 pi 能力，做外层治理/编排/体验 |
| **接口先行** | 模块间 JSON 可序列化 DTO + AsyncIterable，不直接依赖内部实现 |
| **模板隔离** | PTL：独立 pi 进程 + `PI_TEMPLATE`；PTH：Engine 层强制校验 |
| **错误用判别联合** | `Result<T> = {ok:true, data} \| {ok:false, error}` |
| **任务即数据包** | 任务 text 代码形态 + payload 自带路由（flow）——零 eval 零 new Function |
| **可观测优先** | 日志链路 ctx + 四层指标，从开发期就计量 |
| **零外部依赖（扩展）** | bundled 扩展只用 `node:` 内置 + 相对导入 |

---

## 🛠️ Development

```bash
npm run build && npm link # ★ 先 build：ptl/pth bin 跑 dist/，端到端验证前必须 build
npx vitest run           # 1897 tests（232 文件，9 hostile skip）
npm run lint             # 类型检查 + 模块边界 + pth-config 门禁
bash scripts/check-release-clean.sh  # 发行门禁（发布包零用户痕迹）
```

> ⚠️ `tsc --noEmit` 与 vitest 都不产出/不依赖 dist，会掩盖"改了 src 未重建"的问题；CLI 冒烟前务必 `npm run build`。

### 扩展开发

| 想做什么 | 参考 |
|----------|------|
| 新建 pi 扩展（bundled） | `extensions/pit-providers/` — provider 注册 |
| 扩展命令 + 参数补全 | `extensions/pit-control/index.ts` — registerCommand |
| 跨会话通信 | `extensions/mailbox/` — 文件邮箱 + Delivery 决策 |
| PTH 任务交互扩展 | `extensions/pth-tasks/` — /pthtask 命令族 |
| PTH 任务内核扩展 | `src/pth/kernel/` — 见 [Kernel 体系](./docs/pth/kernel.md) |
| PTL 加 CLI 命令 | `packages/framework/src/cli/` + `pit.ts` |
| TUI 新页面 | 遵循 [Screen 布局模板](./packages/framework/src/tui-shared/README.md) 5 条规则 |

---

## 📖 Documentation

| 文档 | 内容 |
|------|------|
| [docs/README.md](./docs/README.md) | ★ 全部文档索引（specs/plans/runbooks） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构总览（单一真相源） |
| [PTL 架构](./docs/ptl/architecture.md) · [创作指南](./docs/ptl/authoring.md) | PTL 子系统 / 技能扩展放置规范 |
| [PTH 架构](./docs/pth/architecture.md) · [Kernel 体系](./docs/pth/kernel.md) | PTH 分层 / 任务内核专档 |
| [PTH API](./docs/pth/api.md) · [部署](./docs/pth/deployment.md) | 端点参考 / 本地+Docker 部署 |
| [性能计量 SPEC](./docs/superpowers/specs/2026-08-08-pth-perf-metrics-design.md) | 四层 35+ 指标设计 |
| [多语言 REPL SPEC](./docs/superpowers/specs/2026-08-08-pth-multilang-repl-design.md) | PyKernel/BashKernel 协议与池化规划 |

---

## 🗺️ Roadmap

### ✅ 已完成

- [x] PTL：tmux 多会话管理 + 双 TUI（dashboard/lab）+ PTL→PTH 桥（hub submit + hub kernel）
- [x] PTL：共享扩展层 + pit-providers 统一 provider 后端 + mailbox 跨会话通信
- [x] PTL→PTH 桥：`ptl hub submit/run` — agent 程序打包提交到 PTH 运行
- [x] PTH：多语言持久 REPL（PyKernel 230x / BashKernel / TS VM + KernelManager）
- [x] PTH：任务池（发布/认领/执行/submit-reject 闭环 + 模板库 + 批量 worker）
- [x] PTH：记忆闭环（Refine 管线：快照→LLM→tool-function 源码+spec/洞察双通道 + state 召回）
- [x] PTH：任务链（TaskResolver：payload.flow 自带路由 + 自动验收闭环）
- [x] PTH：日志体系（KernelLogger + taskId 链路 + batch IPC 转发）
- [x] PTH：监控设施（四层 35+ 指标 + /metrics + ResourceProvider 跨 OS）
- [x] 凭据统一：`resolveSdkConfigPaths` 唯一出口（PTL/PTH 同源）

### 🚧 规划

- [ ] PTH：任务池 v2（deps 就绪过滤、自然语言任务支持）
- [ ] PTH：REPL 进程池化（min(worker, CPU)）
- [ ] PTH：Windows 平台适配
- [ ] PTH：Dapr/K8s Phase 2 迁移

---

## 已知限制

- **PTL 无 HTTP API**：面向本地多 pi 环境共存管理；需要程序化调用 PTH 时使用 PTH CLI。
- **PTH 暂无专属前端**：以 CLI 为规范调用接口（HTTP/SSE 为兼容通道）；专属前端与无容器版本在规划中。
- **tmux**：Unix-only（Windows 支持规划中）
- **PTH 进程限制**：BullMQ worker 在主进程（Phase 1 技术债）
- **mailbox**：单机通信，不支持跨机器
- **任务 text 兼容双形态**：代码形态直执行，自然语言走 NL 翻译（PTC 程序模式）

---

## 📄 License

MIT
