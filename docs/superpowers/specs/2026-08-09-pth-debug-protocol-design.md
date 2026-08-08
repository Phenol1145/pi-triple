# 调试协议设计（可选扩展 + 回退链）SPEC v1.0

> 日期：2026-08-09 · 状态：已批准（用户裁决）· 关联：[编译核 SPEC](./2026-08-09-pth-compiled-kernel-design.md) · [工具面收敛设计](./2026-08-09-pth-agent-tool-convergence-design.md) · 参考：[调试工具研究参考](../explorations/2026-08-09-debugging-tools-research-reference.md)

## 1. 定位：可选扩展（用户裁决）

```
核心协议（Interpreter 接口——最小面，恒可用）：
  execute / snapshot / reset / dispose / Observation

可选扩展（渐进提供——缺失时优雅降级，不阻断任务）：
  Debuggable（调试会话——gdb/dlv 适配器）
  诊断构建（sanitize/警告全开）
  bash 核回退通道（L1/L2 工具链）
  → 判定标准：核心能力缺失 = 任务失败；扩展能力缺失 = 降级路径提示
```

## 2. 调试协议基本集（已实现 2026-08-09——commit 323dab3）

```
Debuggable extends Interpreter（debug() → DebugSession | null）
DebugSession：
  attach(source) / setBreakpoint(line, condition?) / continueExec()
  step(into|over|out) / stack() / variables(frame?) / evaluate(expr, frame?) / detach()
实现：CDebugSession（编译 -g -O0 + gdb -i=mi2 管道——gdb MI 解析器 12 测试）
```

## 3. 四级调试回退链（核心设计）

```
L0 完整调试（Debuggable——gdb/dlv）            ← 首选
   attach/breakpoint/continue/step/stack/variables/evaluate

L1 诊断构建（编译核 build 选项）                ← gdb 不可用/调试版编译失败
   cc -fsanitize=address,undefined -Wall -Wextra main.c -o main_asan
   → ASan/UBSan 报告（内存错误/UB——比断点更早暴露根因）
   → -Wall -Wextra 静态级诊断（类型问题/未用变量）
   → 诊断二进制独立缓存键（hash+sanitize 后缀——不污染正常缓存）

L2 外部工具（bash 核内执行）                    ← L1 不够时
   strace ./main（系统调用级）/ valgrind ./main（内存检查）
   MALLOC_CHECK_=3 / ASAN_OPTIONS=... 环境变量调参
   → bash 核是通用执行通道（二进制/文件系统共享——零新协议）

L3 基础（Observation 恒可用）                  ← 编译核原生
   退出码 / stdout / stderr / 编译诊断回填
```

### bash 核回退通道（用户确认的路径）
```
① 二进制编译后在工作区——bash 核 cwd 共享 → ./main 直接跑
② 调试工具全是命令——bash 天然执行（strace/valgrind/ASan 环境变量）
③ LLM 自主决策：attach 失败信息 → 选 L1/L2/L3
   （bash.execute 或 ts 程序调 bash——已有工具面，零新协议）
```

## 4. 接入语义

```
① attach 失败：明确错误回填（gdb 不存在/调试版编译失败）——LLM 收到后可降级
② 编译核 build 扩展：
   build(source, { sanitize: "address"|"undefined"|"both", warnings?: true })
③ 降级决策：LLM 自主（默认）或 env 自动（PTH_DEBUG_FALLBACK=auto|off——
   auto 时 attach 失败回填附带 L1 命令提示）
```

## 5. 编译器变体（同语言多编译器——用户澄清）

```
CompilerProfile.variants: Record<string, CompilerVariant>
  clang（preference 2）/ gcc（1）/ tcc（3——快编译无优化）
选择链：显式参数（c.execute { compiler }）> env（PTH_C_COMPILER）> auto（which 检测）
差异封装点：编译参数/调试信息（-g 同产 dwarf——gdb 统一）/诊断格式（透传不解析）
用途：默认跑任务 / clang↔gcc 交叉验证（UB 线索）/ tcc 快速迭代
```

## 6. 与 agent-centric 高层接口的关系（暂缓——调研中）

```
L1/L2 诊断报告已是"agent-friendly 调试"的过渡形态——
调研结论出来后，高层接口（函数级 trace）在 L0-L2 之上叠加（不替换）
```

## 7. 落地阶段

```
Phase 1（已完成 2026-08-09）：调试协议基本集（Debuggable + gdb MI + CDebugSession）
Phase 2：编译核变体化（variants 重构——resolveCompiler 选择链）+ 测试
Phase 3：诊断构建（build sanitize 选项 + 独立缓存键）+ L2 工具文档
Phase 4：sandbox 集成（镜像装 gdb/gcc/clang + kernel-host debug 端点 + 容器验证）
Phase 5：（调研后）agent-centric 高层接口 + debug.* 工具面
```

## 8. 裁决记录

| # | 裁决 |
|---|------|
| 1 | 调试工具 = 可选扩展（核心最小面 + 扩展渐进提供 + 缺失降级不阻断） |
| 2 | 四级回退链（L0 gdb/L1 sanitize 诊断/L2 bash 工具/L3 Observation） |
| 3 | bash 核 = 回退执行通道（零新协议——二进制/文件系统共享） |
| 4 | 编译器变体（gcc/clang/tcc——显式 > env > auto 选择链） |
| 5 | agent-centric 高层接口暂缓（调研后叠加） |
| 6 | 基本调试集先行（已落地）；工具面待调研后设计 |
