# PTH 配置集中化可执行计划

> **计划状态：可执行（2026-08-16 建立）**
>
> **用户裁决**：
> 1. 形态 = **Schema + 单入口 loader + ConfigCenter 权威化**；
> 2. 密钥 = **统一 secrets 文件（gitignored）+ 全部密钥 `:?` fail-closed + 生产禁开发默认值**；
> 3. 范围 = **只做 PTH 侧**；PTL 保持开发便捷性，不加强管理，只提供**信息迁移通道**（`pth config export`）。

## 现状基线（2026-08-16 盘点）

- `src/pth` 生产代码读取 `PTH_*` **104 个原始键**（去前缀片段/测试占位 ≈ 95 实项）+ 非 PTH 基础设施 ~15 项；
- **72 处** `process.env.PTH_*` 直读，散布 19 个文件；compose 只声明 42 个 PTH 键，61 个键仅存在于代码默认值；
- ConfigCenter（`kernel/extensions/perf-params.ts`）只被 3 个消费者使用，主/batch 各一份、无跨进程同步；
- **安全问题**：ConfigCenter.snapshot 会把 `PTH_EXECUTION_GRANT_SECRET` 等密钥直接暴露给 worker 的 `perf.params()`；
- 密钥分散：compose `${VAR:?}` ×2、`${VAR:-}` 可空 ×1、开发默认密码 ×1、`auth.json` 文件凭据、CLI `test-token-123` 默认值。

## 目标架构

```
src/pth/config/
  schema.ts        PthConfigDef：key/type/default/secret/runtime/group/scope/description（唯一真相源）
  config-center.ts ConfigCenter：env + schema 默认值合并 → 内存注册表；set/on 通知；
                   snapshot(includeSecrets=false)——密钥默认打码
  index.ts         pthConfig() typed 访问器（str/num/flag/enabled/list）——组件唯一读入口
                   loadConfig/validateConfig/exportPtlMigration

kernel/extensions/perf-params.ts → 兼容 re-export（不破坏既有 import 面）

scripts/check-pth-config.ts
  - src/pth 内 config/ 以外禁止 process.env.PTH_* 直读（防回潮，baseline 0）
  - schema 键 ↔ compose 声明覆盖度报告（信息项，不 fail）

deploy/.env.pth.secrets.example（gitignored：.env.pth.secrets）
  SANDBOX_SHARED_SECRET / PTH_EXECUTION_GRANT_SECRET / PTH_MEMORY_BRIDGE_TOKEN /
  POSTGRES_PASSWORD / REDIS_PASSWORD（全部 :? fail-closed）
```

## 执行阶段

### C1：schema + 单入口 + ConfigCenter 权威化
- [x] C1-1 `src/pth/config/schema.ts`：全部 PTH_* 与基础设施键（类型/默认值/secret/runtime/group/scope/description）
- [x] C1-2 `config-center.ts`：env+schema 合并、typed accessors、snapshot 密钥打码、set/on
- [x] C1-3 `perf-params.ts` 兼容 re-export；旧测试不破
- [x] C1-4 测试：默认值兜底、typed 解析、密钥打码、runtime set/on

### C2：72 处直读迁移 + 防回潮检查
- [x] C2-1 main/assembly/batch-process 等 19 文件迁移到 `pthConfig()` / `config()`
- [x] C2-2 `scripts/check-pth-config.ts` + npm script（`check:pth-config`，并入 lint）
- [x] C2-3 全量回归：config 相关既有测试

### C3：secrets 收口 + compose 收紧
- [x] C3-1 `.gitignore` + `deploy/.env.pth.secrets.example`
- [x] C3-2 生产 compose：全部密钥 `:?`；`POSTGRES_PASSWORD`/`REDIS_PASSWORD` 去开发默认；REDIS_URL 分字段拼装 + redis AUTH；dev compose 保留本地默认
- [x] C3-3 启动校验：生产（`PTH_CONFIG_STRICT=1`）检测开发默认值/弱密钥 → fail-fast
- [x] C3-4 文档：`docs/pth/configuration.md`（唯一配置文档）

### C4：PTL 迁移通道 + 全量门禁
- [x] C4-1 `pth config list`（分组表、密钥打码）+ `pth config export`（输出 `ptl config set pth.url/pth.token` 迁移命令）
- [x] C4-2 docs/README 增加 configuration 行；deployment 引用更新
- [x] C4-3 全量 `npm test` + `npm run lint`（含 check:pth-config）+ `npm run build` 全绿
- [x] C4-4 收账 + 独立提交

## 收账证据（2026-08-16）

- schema：**107 键**（全部 PTH_* 生产读取 + 基础设施键；含 8 个 secret、~35 个 runtime 键）；
- `src/pth` 内 `process.env.PTH_*` 直读：**0**（19 文件 72 处全部迁移；`check:pth-config` 防回潮并入 lint）；
- 全量 vitest：**232 文件通过 / 1897 用例绿 / 9 hostile skip**；
- `npm run lint`：boundaries 0 违规 + pth-config 通过；`npm run build` 干净；
- `pth config` / `pth config export` CLI 烟测通过；
- 密钥面：compose 全部 `:?`、redis AUTH、`PTH_CONFIG_STRICT=1` 生产校验、snapshot/CLI 密钥打码。

## 退出门禁

- src/pth 内 config/ 之外 `process.env.PTH_*` 直读 = 0；
- 全量 vitest / lint（boundaries + pth-config）/ build 绿；
- 公开行为兼容：所有默认值与迁移前一致（schema 默认值 = 迁移前代码内联默认值）；
- 密钥打码后 `perf.params()` 不再泄露 secret。
