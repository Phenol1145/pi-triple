# 编译核协议设计（编译类语言统一协议）SPEC v1.0（草案）

> 日期：2026-08-09 · 状态：草案（待用户确认裁决）· 依据：[LLM agent 执行设计](./2026-08-08-pth-llm-agent-execution-design.md) · [kernel sandbox 设计](./2026-08-08-pth-kernel-sandbox-design.md) · [工具面收敛设计](./2026-08-09-pth-agent-tool-convergence-design.md) · 参考：[编译语言 REPL 会话记录](../explorations/2026-08-09-compiled-language-repl-reference.md)

## 1. 背景与动机

解释类语言已有统一 REPL 核协议（Interpreter 接口 + Observation + kernel-host 池）。
**编译类语言（C/C++/Go/Rust/汇编）缺少类似的统一协议和工具**。

关键裁决（用户 + 会话参考）：**REPL 不适用于编译语言**（状态保留本质困难——编译后
变量变寄存器）——编译核 = **编译-运行管道（compile-run pipeline）**，作为 PTC 执行载体。

## 2. 设计定位

```
CompiledKernel（实现 Interpreter 接口——LLM/agent 零认知差）：
  execute(source, { lang, timeoutMs? }) → Observation
    └─ 自动两阶段（增量）：
       Phase 1 编译：源码 sha256 → 缓存命中？→ 跳过
                    未命中 → 工具链编译 → 二进制入缓存
       Phase 2 运行：独立进程 → stdout/stderr/value（同一 Observation）

  build(source, { lang }) → { ok, binaryRef, diagnostics }   ← 显式编译（LLM 可分开控制）
  run(binaryRef, { args?, stdin? }) → Observation             ← 显式运行（复用二进制）
  reset() → 清构建缓存（工作区级）
  snapshot() → 工作区产物清单（生成文件/二进制引用——refine 输入）

状态模型：文件即状态（无进程内命名空间——跨 execute 靠工作区文件）
  · 程序写文件 → 后续程序读文件（与 PTC 的 fs 能力天然衔接）
  · 无懒 spawn/空闲回收（每次运行独立进程——池化对象 = 二进制缓存）
```

## 3. 工具面衔接（元工具随语言增长——工具面收敛设计延续）

```
动作工具（新增元工具）：
  go.execute { code, mode? }    ← Go 编译+运行一步（首发）
  （未来）c.execute / rust.execute / ...

能力函数（不变——ts 程序内）：
  fs 读写（文件即状态通道）/ memory.query / results / context

v1 务实分工（回避程序内工具调用机制）：
  编译语言 = 【重计算单元】：PTC 程序（ts）编排 + 能力直达
  ts 程序：await go.execute("大矩阵计算...") → 拿结果 → 继续编排
  → 编译 kernel 纯计算 + 文件 IO（无程序内工具调用）
```

## 4. 增量缓存与构建产物管理

```
缓存：工作区 .build-cache/<lang>/<sha256>/（源码 hash → 二进制 + 编译诊断）
参数：
  PTH_COMPILE_CACHE_MAX     默认 50（二进制数上限——LRU 淘汰）
  PTH_COMPILE_CACHE_MB      默认 500（大小上限）
  PTH_COMPILE_TIMEOUT_MS    默认 120s（编译超时）
"REPL 感" = 同一源码重复 execute 毫秒级（无编译）
```

## 5. 执行位置与安全

```
sandbox 侧（编译类代码同样不可信——执行隔离与 python/bash 一致）：
  · sandbox 镜像 + Go 工具链（首发；后续 C/Rust 增补）
  · 编译-运行在 sandbox kernel-host 池内（CompiledKernel 实现入宿主）
  · 敏感信息约束照旧（sandbox 零业务密钥——编译过程不注入凭据）
  · 构建产物落工作区（共享卷）——与解释类同一路径约定
```

## 6. 首发语言（用户裁决 2026-08-09：C 替代 Go）

```
C（gcc/clang——用户裁决）：
① 工具链最通用（gcc 无处不在；clang 兼容）
② 编译快（单文件秒级）——增量缓存后毫秒
③ 调试生态成熟（gdb/lldb——调试协议 v1 的天然载体）
④ 镜像小（gcc ~100MB vs Rust ~2GB）
备选：Go（go run 零配置）/ Rust（cargo 增量强但镜像大）
```

## 7. 编译类 vs 解释类协议对照

| 维度 | 解释类（现状） | 编译类（本设计） |
|------|--------------|-----------------|
| 执行模型 | REPL（常驻进程） | 编译-运行管道（独立进程） |
| execute 语义 | 代码即执行 | 自动两阶段（增量编译+运行） |
| 状态 | 命名空间（ns/cwd/vm context） | **文件即状态**（工作区） |
| 池化对象 | 进程池（懒 spawn/空闲回收） | **二进制缓存**（sha256/LRU） |
| reset | 清命名空间 | 清构建缓存 |
| snapshot | 变量/函数枚举 | 产物清单 |
| 工具调用 | 能力函数注入（ts 程序） | v1 重计算单元（ts 编排）；v2 程序内调用 |

## 8. v2+ 演进（编译语言独特优势——不阻塞 v1）

```
① 程序内工具调用：编译程序经 HTTP 能力回调 / CLI 子进程调 PTH 能力（能力桥复用）
② 静态分析：编译期诊断 → 资源预测（循环风险/成本估算）→ 回填 agent 经济模型
③ 并行 DAG：多语言/多程序并行调度（parallel 语义）
④ 更多语言：C/Rust/汇编（keystone 方向）——元工具随语言增长
⑤ （远期）Agent DSL / WebAssembly runtime
```

## 9. 待裁决点

| # | 点 | 建议 |
|---|----|------|
| 1 | v1 定位：重计算单元（ts 编排，无程序内工具调用） | ✅ 采纳 |
| 2 | 首发语言 C（gcc/clang 通用/调试生态成熟） | ✅ 采纳（用户裁决——Go 备选） |
| 3 | sandbox 侧工具链（隔离与 python/bash 一致） | ✅ 采纳 |
| 4 | 缓存参数（50 个二进制/500MB/LRU） | 确认 |
| 5 | 元工具命名：go.execute vs 统一 compile.execute {lang} | 确认 |

## 10. 落地阶段

```
Phase A：CompiledKernel 核心（C/gcc）
  - compile-run 管道（sha256 缓存/LRU/诊断回填）
  - build/run 分离 + 文件即状态约定
  - 单测：增量缓存命中/未命中/编译错误/运行超时/产物清单
Phase B：sandbox 集成
  - kernel-host 池加 compiled kernel（Go 工具链镜像）
  - SandboxKernel 复用（同 Interpreter 接口——零上层改动）
Phase C：工具面接入
  - go.execute 元工具 + 能力文档 + 描述
  - 端到端：PTC 程序调用 go.execute 重计算（对比 python 性能/正确性）
  - 压测落档（编译缓存命中率/耗时）
```
