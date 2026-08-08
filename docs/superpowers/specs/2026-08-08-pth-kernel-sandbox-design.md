# REPL kernel 迁移 sandbox 侧设计（kernel 宿主 + 池化归属）SPEC v1.0

> 日期：2026-08-08 · 状态：已批准（用户裁决） · 关联：[LLM agent 执行设计](./2026-08-08-pth-llm-agent-execution-design.md) · [REPL SPEC](./2026-08-08-pth-multilang-repl-design.md)

## 1. 背景与动机

用户裁决：**REPL kernel（PyKernel/BashKernel）应该落在 sandbox 侧**（隔离容器），之前的 REPL kernel 池化设计也是如此——**池化的正确归属是 sandbox 侧的共享 kernel 池**。

现状：
```
试运行：REPL kernel 在宿主机（batch 子进程内 spawn）——无隔离
生产：REPL kernel 在 pi-platform 容器内——容器边界但与非可信执行同容器
sandbox 容器：仅有 bash 一次性执行（POST /exec），无 python、无持久 kernel
```

目标：**执行层与受信层分离**——kernel 跑在无密钥无出网的 sandbox 容器，PTH 侧（密钥/LLM/记忆/指挥）通过协议调用。

## 2. 目标架构

```
PTH 侧（受信：密钥/LLM/记忆/指挥）        sandbox 侧（隔离：执行/无密钥/无出网）
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ ts vm 指挥层（PTC 写程序）     │        │ kernel 宿主服务（新）          │
│ agent 循环 / llm / memory     │ HTTP   │  ├─ PyKernel 池（持久进程）   │
│ kernel 协议客户端             │ ─────▶ │  │   · 命名空间 ns 隔离       │
│  （SandboxKernel 适配器）     │        │  │   · 空闲回收/懒创建        │
└──────────────────────────────┘        │  └─ BashKernel 池（持久会话） │
                                        │      · cwd/env 隔离           │
                                        └──────────────────────────────┘
关键边界：
  - llm 调用只能在 PTH 侧发（sandbox 不持密钥——恶意代码拿不到凭据）
  - ts vm 留在 PTH 侧（指挥层依赖 llm/memory/web；vm 白名单本身是隔离）
  - kernel 池 = sandbox 容器内（多 batch 共享——池化正确归属）
```

## 3. 改造三层

### 3.1 sandbox 镜像扩展（Dockerfile.sandbox）
```
+ python3 + pip + numpy（任务代码 python 常用——宿主要能跑 PyKernel）
+ 保留现有：bash/curl/tmux/git + 非 root + egress 内网锁
+ kernel 宿主服务（src/sandbox/kernel-host.ts，Fastify 应用）
```

### 3.2 sandbox 侧 kernel 宿主协议（新增，src/sandbox/kernel-host.ts）
```
POST /kernel/acquire  { lang: "python"|"bash" } → { kernelId }  池分配（空闲优先/FIFO）
POST /kernel/execute  { kernelId, code, timeout } → Observation  管道 JSON-RPC 转发
POST /kernel/reset    { kernelId } → ok                          ns 清命名空间（不重启）
POST /kernel/release  { kernelId } → ok                          归还池（空闲回收）
GET  /kernel/status   → { pools: { lang, inFlight, idle, size } } 池状态（监控/扩缩容信号）
GET  /health          （现有，无认证——内网可达）

安全：共享密钥认证（SANDBOX_SHARED_SECRET，与 /exec 同源）；cwd 白名单；超时强杀；
     池内 kernel 无出网（compose internal 网络）无密钥。
```

### 3.3 PTH 侧 kernel 适配（SandboxKernel 模式）
```
本地模式（现状）：PyKernel/BashKernel 本地管道——保留（试运行/开发/无 sandbox 降级）
SandboxKernel 模式（生产）：实现同一 Interpreter 接口：
  execute → POST /kernel/execute（重试/超时映射）
  reset → POST /kernel/reset（ns 语义）
  snapshot → POST /kernel/execute 内联协议（宿主转发）
  dispose → POST /kernel/release

模式切换：PTH_PYTHON_MODE=PTH_BASH_MODE = "sandbox-kernel"（新增；默认保持 kernel 本地——
          兼容试运行；生产 compose 注入 sandbox 模式）
参数（仿 PG）：
  PTH_SANDBOX_URL（默认 http://sandbox:8080——compose 已有 SANDBOX_URL）
  PTH_KERNEL_POOL_SIZE（默认 0=宿主自动 min(角色数, CPU/2)；sandbox 侧生效）
```

## 4. 安全边界（最终形态）
| 层 | 边界 |
|----|------|
| 容器 | sandbox 无密钥无出网（internal 网络）——**恶意代码拿不到凭据** |
| vm | ts 指挥层白名单（capability 注入）——语言层无能力 |
| kernel | 池内进程 cwd 白名单 + 超时强杀 |
| 协议 | 共享密钥认证 + fail-closed |

对比 Prime Agent（裸 IPython 无沙箱）：PTH 的"受信指挥层 + 无密钥执行层"是本质性更强的隔离。

## 4.5 敏感信息处理（用户强调——API key 等凭据）

### 敏感信息清单与流向（实测 2026-08-08）
| 项 | 位置 | PTH 侧 | sandbox 侧 | 任务代码可达性 |
|----|------|--------|-----------|---------------|
| LLM API key | auth.json（PI_CODING_AGENT_DIR） | ✅ ModelRuntime 读 | ❌ 不注入 | ts vm：✗（无文件/无 process）；sandbox python/bash：✗（无文件） |
| DATABASE_URL（含 pg 密码） | env（batch 连 pg 必需） | ✅ | ❌ | ts vm：✗；**本地模式 python/bash：⚠️ 可读**（进程继承 env）；sandbox 模式：✗ |
| USTC_PAN_TOKEN 等用户 token | env（宿主） | ✅（宿主进程） | ❌ | 同上 |
| SANDBOX_SHARED_SECRET | env（sandbox 认证自身） | ✅（客户端） | ✅（服务端） | ✗（不注入 kernel 进程 env） |

### 约束（spec 强约束）
```
① sandbox 容器零敏感信息：
   - 镜像构建：不 COPY 任何配置/密钥；Dockerfile 无 ARG/ENV 凭据
   - 运行时 env：compose 只注入 SANDBOX_SHARED_SECRET（沙盒自身认证）+ 非敏感配置；
     明确禁止 ANTHROPIC_API_KEY/DATABASE_URL/用户 token 进入 sandbox 服务
② kernel 宿主协议不接受 env 注入：
   - /kernel/execute 请求体无 env 字段（区别于 /exec 的 env 增量）
   - 若未来需要 env：白名单 key 校验（拒绝 KEY/TOKEN/SECRET/PASSWORD/URL 模式）
③ PTH 侧最小暴露：
   - auth.json 只被 ModelRuntime 读（resolveSdkConfigPaths 显式路径——已落地）
   - ts vm 无 process/fs（语言层无能力——已隔离）
   - batch 进程 env 仅保留运行必需（DATABASE_URL 连 pg 必需；其余用户 token 尽量宿主级）
④ 本地模式风险标注（开发形态接受）：
   - 无 sandbox 时 python/bash 在宿主侧，进程继承 env——任务代码理论上可读 env
   - 生产必须切 sandbox-kernel 模式（隔离消除）；本地仅限开发/试运行
```

### 验证手段
```
- 镜像扫描：门禁脚本检查 Dockerfile.sandbox 无凭据字面量
- 协议单测：/kernel/execute 拒绝 env 字段；敏感 key 名过滤测试
- 运行期检查：sandbox 容器 env 白名单断言（启动时校验无 KEY/TOKEN/SECRET/PASSWORD）
- 端到端验证：sandbox 模式下 python.execute("import os; os.environ") 返回空/无敏感项
```

## 5. 与现有体系的关系

| 资产 | 变化 |
|------|------|
| PyKernel/BashKernel（管道 JSON-RPC） | **复用为宿主的 kernel 实现**（协议内部化到 sandbox 侧） |
| kernel-config（懒 spawn/空闲回收/ns reset） | 语义映射到宿主池（acquire 懒创建/release 后回收/reset 清 ns） |
| Interpreter 接口 | PTH 侧 SandboxKernel 适配器实现同一接口（零上层改动） |
| agent 循环 / PTC / capability | 不变（ts vm 侧照旧；python/bash 工具走 SandboxKernel） |
| 池化 | **归属确定：sandbox 侧共享池**（多 batch 复用——替代 per-batch 本地池） |
| 自动扩缩容 | 信号增强可选：/kernel/status 的池压力作为扩容参考 |
| 监控 | kernel exec 指标照常（PTH 侧 onKernelMetric 包装 SandboxKernel） |

## 6. 落地阶段

```
Phase A：sandbox 侧 kernel 宿主
  - Dockerfile.sandbox + python3/numpy
  - src/sandbox/kernel-host.ts（acquire/execute/reset/release/status + 池管理）
  - 宿主复用 PyKernel/BashKernel 实现（抽成公共模块 src/shared/kernel-core？）
  - 单测：宿主池（acquire 空闲优先/FIFO/release 回收）+ 协议路由
Phase B：PTH 侧 SandboxKernel 适配
  - SandboxKernel 实现 Interpreter（HTTP 客户端 + 重试/超时）
  - PTH_PYTHON_MODE/PTH_BASH_MODE = "sandbox-kernel"
  - 集成测试：本地起 kernel-host（testcontainers 或直连）→ 全链路任务
Phase C：生产接线 + 验证
  - compose：sandbox 暴露 kernel 端口（internal 网络）+ pi-platform 注入模式 env
  - 容器内端到端：agent 任务（python/bash 工具走 sandbox kernel）
  - 压测对比：sandbox 模式 vs 本地模式的耗时/内存
```

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| 网络往返开销（本地管道 → HTTP） | kernel 池化复用减少 acquire 次数；execute 单次往返（~1ms 内网）；实测对比 |
| 宿主无密钥——任务要 LLM 怎么办 | **设计使然**：LLM 调用必须回 PTH 侧（ts 程序里 llm.complete 走 PTH）——python 程序内不允许 LLM（隔离边界） |
| 池内状态串味 | ns 隔离（reset 清命名空间）+ cwd 白名单 |
| 试运行无 sandbox | 默认本地模式保留（降级路径） |
| 协议/API 变更影响 | SandboxKernel 实现 Interpreter 接口——上层（agent 循环/任务）零改动 |
| sandbox 镜像变大（python） | 接受（slim + python 精简）；numpy 可选装（PTH_SANDBOX_PYTHON_EXTRA） |

## 8. 裁决记录

| # | 裁决 |
|---|------|
| 1 | REPL kernel 执行层落在 sandbox 侧（用户裁决） |
| 2 | kernel 池化归属 sandbox 侧共享池（多 batch 复用） |
| 3 | ts vm 留在 PTH 侧（指挥层依赖 llm/memory；vm 白名单隔离） |
| 4 | llm 调用只能 PTH 侧发（sandbox 无密钥——安全边界） |
| 5 | 本地模式保留（试运行/降级）；生产注入 sandbox-kernel 模式 |
| 6 | PyKernel/BashKernel 实现复用为宿主的 kernel 核心 |
| 7 | Interpreter 接口不变（SandboxKernel 适配器实现） |
