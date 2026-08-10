# 代码审计报告（2026-08-10——断链/死代码/模块化/复用率）

> 工具：ts-prune（未使用导出）+ knip（未使用文件/依赖/导出）+ madge（循环依赖）+ 人工验证。
> 基线：main @ a22c6a8（1288 测试全绿）。

## 一、断链（定义了没接线——功能缺失/意图未达）

| 断链 | 设计意图 | 现状 | 处理 |
|------|---------|------|------|
| `__setDirectMetric`（llm-fn）| directOpenAiComplete 计量注入 | **冗余**——createLlmFn 内部 `depsMetric = deps.onMetric` 已接线 | ✅ 删除 |
| `executePthCommand`（commands.ts）| `/pth` 斜杠命令族（装配层 Task 3）| **slash 注册面不存在**——旧设计残留（hub API 已替代）| ✅ 删文件+测试 |
| `tui-lab/index.tsx` `tui-ptl/index.tsx` | 独立 bin 入口（shebang）| **未注册 package.json bin**（ptl tui 动态 import app.js——活路径）| ✅ 删除 |
| tui-shared 组件（TopBar/TabBar/StatusBar/SparkLine/BarChart）| TUI 共享组件库 | **TUI 面板零引用**（各页面自己实现）| ⏸ 保留（TUI 演进中——标注）|

## 二、死代码（已删除）

| 文件/导出 | 说明 |
|-----------|------|
| `src/pth/tools/spi.ts` | ToolExecutor 旧 SPI 残留（types.ts 仍被 platform/registry 用——spi.ts 孤立）|
| `src/pth/kernel/execution/index.ts` | barrel 死（全员直接 import 具体文件——grep 验证零引用）|
| `packages/framework/src/containers/index.ts` | barrel 死（子文件活——bridge/containers.ts 直接引用子文件）|
| `listJobReports`（bridge/jobs.ts）| 无引用 |
| `interactiveSelect`（picker.tsx）| 无引用 |
| `unlinkTemplateFromShared`（shared-layer.ts）| 无引用 |
| `PythonInterpreter`（interpreter/index barrel re-export）| kernel-manager 直接从 python-interpreter.js import |
| 未使用依赖 ×5 | cli-highlight / crypto-js / marked / pino（声明未用——logger 自研"pino 兼容"非 pino）/ @pi-triple/framework（root 自依赖）|

## 三、风险修复（P0）

| 风险 | 处理 |
|------|------|
| **zod 未声明但使用**（ext-manifest.ts 扩展 manifest 校验 + containers/deployment.ts——生产靠 transitive 依赖侥幸——npm 不保证 transitive 顶层）| ✅ root + framework 显式声明 zod ^4.0.0（对齐实际安装 4.4.3）|

## 四、复用率改进

| 改进 | 说明 |
|------|------|
| `PthClient.streamSSE()` | SSE 消费统一出口（console --follow 从裸 fetch 40 行 → streamSSE 回调——后续流式命令复用）|

## 五、保留观察（下轮候选——本轮不动）

| 项 | 现状 | 建议 |
|----|------|------|
| `agent-engine.ts` 979 行 | 核心引擎单文件过长 | 拆分（会话恢复/检查点/drain 子模块）——大工程——专项 |
| 循环依赖 ×9（madge）| **全部类型级**（`import type`——运行时断环——1281 测试+生产验证无害）| 标注不修——未来新增强依赖时注意 |
| `lab-data/index.ts` barrel 半死 | 部分导出未用（arena/telemetry 子文件活——tui-lab 直接引用子文件）| 保守留——TUI 定稿后清理 |
| `run.ts` re-export（printBanner/printHelp/getVersion/resolveOrFail）| 测试兼容用途 | 保留 |
| `resetEventBus`（event-bus.ts）| 测试用（ext-e2e/ext-registry）| 保留 |
| 逐 token 真流式 | 当前轮次级 token 进度 | v2（LLM stream 改造）|

## 六、审计方法（可复跑）

```bash
npx knip --config knip.json          # 未使用文件/依赖/导出（knip.json 已入仓——archive/extensions 等已排除）
npx ts-prune                          # 未使用导出（"used in module" 后缀=模块内类型——正常）
npx madge --circular --extensions ts src/ packages/framework/src/   # 循环依赖
```

**验证**：删除后 1281 测试全绿 + 双 tsc 干净 + 生产 dev 热更新正常（console --follow 实测回放+实时）。
