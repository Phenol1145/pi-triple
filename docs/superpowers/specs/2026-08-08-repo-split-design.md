# PTL/PTH 仓库拆分与扩展独立设计（SPEC v1.0）

> 日期：2026-08-08 · 状态：已批准（用户裁决 4/4） · 前置：无
> 关联：[框架拆分设计](./2026-08-07-framework-split-design.md)（packages/ 已就位，本设计在其上做仓库级拆分）

> **整理说明（2026-08-09）**
>
> 文档性质：已批准的仓库治理目标。
>
> 实施映射：当前仍是 `pi-platform` 单仓，拆分阶段尚未执行。
>
> 时间边界：正文中的 0.2.0、文件数量和依赖统计是 2026-08-08 的设计基线；当前包版本和代码规模已经变化。本文标题所称“5 新仓”与拓扑图列出的 4 个新仓之间差异仍按原文保留。参见[Kernel 设计综合总览](./2026-08-09-pth-kernel-design-synthesis.md)。

## 1. 背景与动机

当前 pi-platform 单仓同时承载 PTL（`packages/framework` + 扩展）与 PTH（`src/pth`）两条产品线。
问题：

- 两个产品生命周期不同步（PTL 迭代快、PTH 独立发版需求）——单仓发版互相拖累
- 扩展混杂在单一 bundled 集合，无法独立版本化/独立发布
- 用户希望扩展注册为独立项目（独立 repo/npm）

**目标**：从 v0.2.0 基线起，PTL/PTH 分仓治理；扩展按归属分组；共享包独立发布；旧仓归档。

## 2. 现状调研结论（依赖边界实测）

### 2.1 包依赖图（2026-08-08 实测）

```
packages/shared（零依赖）
  ↑
packages/infra（依赖 pi SDK + pino）        ← PTL 与 PTH 都依赖！
  ↑                 ↑
packages/framework   src/pth（PTH 主代码）
  ↑
packages/mailbox
```

### 2.2 关键发现

| # | 发现 | 影响 |
|---|------|------|
| 1 | **PTH 依赖 @pi-triple/infra**（agent-engine/session-pool/main/tools/platform 均 import：ModelRouter/WorkspaceManager/Logger/EventBus/detectPlatform/createLogger/EnvCredentialProvider/resolveSdkConfigPaths） | infra **必须**独立 npm 包 |
| 2 | PTL→PTH 桥只走 **HTTP 协议**（PthClient，零代码耦合） | 主仓可干净切割 |
| 3 | PTH 对 "ptl" 的引用仅为注释与默认字符串 | 无代码耦合 |
| 4 | packages/shared 仅被 framework/mailbox 使用 | 归 PTL 仓（不独立发布） |
| 5 | extensions 8 个中仅 agent-lab/agent-lab-bidder 依赖 pi SDK；mailbox 依赖 shared；其余零依赖 | 分组拆分可行 |
| 6 | 测试目录已按产品分离：`test/pth-*`（36 文件）vs `test/unit|integration` + 根 e2e | 测试随仓走 |
| 7 | 发行门禁 `scripts/check-release-clean.sh`（KEYWORDS 含 Dockerfile.dev/docker-compose/tools-dev/scripts——dev 容器不进发行包） | 各主仓保留门禁 |

### 2.3 规模（.ts 源文件数）

- PTH 仓候选：`src/pth/` 73 + `test/pth-*` 36 ≈ 109
- PTL 仓候选：`packages/*` 102（不含 dist）+ 扩展 + 根测试
- 共享包：infra 单仓

## 3. 目标拓扑（5 新仓 + 1 归档）

```
┌─────────────────────┐   ┌─────────────────────┐
│  pi-triple-ptl      │   │  pi-triple-pth      │
│  （PTL 主仓，bin）   │   │  （PTH 主仓）        │
│                     │   │                     │
│  packages/framework │   │  src/pth/（全部 73） │
│  packages/mailbox   │   │  src/sandbox+types  │
│  packages/ext-ctn   │   │  test/pth-*（36）    │
│  extensions/        │   │  extensions/pth-tasks│
│   pit-providers     │   │  Dockerfile         │
│   pit-control       │   │  docker-compose.yaml│
│   workflow          │   │  docs/pth/          │
│  test/unit+int+e2e  │   │  docs/superpowers/  │
│  docs/ptl+superpowers│  │   （PTH 相关 subset）│
│  scripts/(门禁/drain)│  │  scripts/(门禁)      │
└─────────┬───────────┘   └─────────┬───────────┘
          │ npm i                    │ npm i
          ▼                          ▼
  ┌─────────────────────┐   ┌─────────────────────┐
  │ pi-triple-infra     │   │ pi-triple-agent-lab  │
  │ @pi-triple/infra    │   │ extensions/agent-lab │
  │ （唯一共享包）       │   │ extensions/          │
  │                     │   │  agent-lab-bidder    │
  └─────────────────────┘   └─────────────────────┘
              │
              ▼
  pi-platform（旧仓）→ GitHub archived（历史全保留）
```

## 4. 各仓内容清单

### 4.1 pi-triple-infra（先拆，依赖序最前）

```
packages/infra/  → 仓库根（或保留 packages/ 结构，二选一：推荐仓库根即包，减少一层）
  src/sdk-paths.ts（resolveSdkConfigPaths——凭据唯一出口）
  src/model-router/ · src/sdk-adapter/ · src/platform/ · src/workspace/
  src/observability/ · src/credential-provider.ts
```
- 发布 `@pi-triple/infra@0.2.0`（npm）
- 独立 tsconfig + vitest + README（infra 使用说明）+ 门禁脚本

### 4.2 pi-triple-pth

- `src/pth/` 全量（gateway/core/kernel/observability/programs/storage/tools/workflow/self-modify）
- `src/sandbox/` + `src/types/`
- `test/pth-*`（gateway/kernel-assembly/kernel-execution/kernel-interpreter/kernel-storage/observability）
- `extensions/pth-tasks/`（+ 其 test/）
- `Dockerfile` + `docker-compose.yaml`（PTH 部署形态；**不含** Dockerfile.dev/dev 容器）
- `docs/pth/`（architecture/kernel/api/deployment）+ docs/README.md 的 PTH 部分
- `scripts/check-release-clean.sh`（KEYWORDS 精简为 PTH 相关）
- 依赖：`@pi-triple/infra@^0.2.0`（npm）；`@earendil-works/pi-coding-agent`
- 版本：0.2.0 继续

### 4.3 pi-triple-ptl

- `packages/framework/`（CLI+TUI+flow+bridge+lab-data）——bin: ptl
- `packages/shared/`（workspace 内联，不独立发布）
- `packages/mailbox/`（依赖 shared，workspace 内联）
- `packages/extensions-in-container/`
- `extensions/`：pit-providers · pit-control · workflow（agent-lab 拆走）
- 根测试：`test/unit` + `test/integration` + 根 e2e（env-cli/concurrent-wal/container-ext/e2e-framework 等）
- `docs/ptl/` + docs/README.md 的 PTL 部分 + 共享层机制文档
- `scripts/`：check-release-clean.sh（KEYWORDS 保留 Dockerfile.dev 等——dev 容器仍在此仓）+ drain.sh + supervisor.sh
- `Dockerfile.dev` + `docker-compose`（dev 容器部分）——**保留但仍在发行门禁拦截外**
- 依赖：`@pi-triple/infra@^0.2.0`（npm）
- 版本：0.2.0 继续

### 4.4 pi-triple-agent-lab

- `extensions/agent-lab/`（经济引擎：WorkLoop/市场/调度/优化/实验 + SQLite）
- `extensions/agent-lab-bidder/`（place_bid 工具）
- 依赖 pi SDK；发布 npm 包名：`@pi-triple/agent-lab` / `@pi-triple/agent-lab-bidder`
- PTL 仓通过 `ptl install --shared @pi-triple/agent-lab` 安装（共享层机制走 npm）

### 4.5 共享层机制（拆分后）

- bundled 概念取消 → 每仓自带扩展集合，随仓发布
- 独立扩展（agent-lab/mailbox 未来）→ `ptl install --shared <npm|repo>`
- `~/.pi-triple/data/shared/extensions/` 现有安装物不受影响（symlink 机制不变）

## 5. 关键决策（用户裁决）

| # | 决策 | 裁决 |
|---|------|------|
| 1 | 拆分粒度 | **2 主仓 + 共享包独立**（ptl/pth/infra） |
| 2 | 扩展独立 | **按归属分组**：PTL 集合 + PTH 的 pth-tasks + agent-lab 大件独立仓 |
| 3 | 旧仓 | **归档保留**（GitHub archived，历史全留） |
| 4 | 版本基线 | **继续 0.2.0**（infra 发 0.2.0；agent-lab 0.2.0） |
| 5 | git 历史 | **推荐 filter-repo 按路径拆分**（各仓继承对应路径历史）——待用户最终确认 |
| 6 | 命名 | pi-triple-{ptl,pth,infra,agent-lab}——待用户最终确认 |

## 6. 迁移顺序（依赖序）

```
Phase 1: pi-triple-infra 独立
  - filter-repo 拆 packages/infra → 新仓；发布 @pi-triple/infra@0.2.0
Phase 2: pi-triple-pth 独立
  - filter-repo 拆 src/pth+sandbox+types+test/pth-*+pth-tasks+Dockerfile 等
  - 依赖切到 npm @pi-triple/infra；构建/测试/试运行验证（1249 测试拆后 PTH 侧全绿）
Phase 3: pi-triple-ptl 独立
  - filter-repo 拆 packages/*+extensions(除 agent-lab)+根测试+docs/ptl
  - workspace 内联 shared/framework/mailbox；依赖 npm infra
Phase 4: pi-triple-agent-lab 独立
  - filter-repo 拆 extensions/agent-lab(+bidder)
Phase 5: 旧仓归档
  - GitHub archived + README 顶部指路新仓；本模板共享层安装源切换
Phase 6: 收尾
  - 各仓 README/CI/门禁独立；docs/README.md 更新为跨仓索引
```

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| PTH 仓缺 infra 不可用 | infra 先发布（Phase 1 先行）；PTH 锁 `@pi-triple/infra@^0.2.0` |
| 发行门禁失效（dev 容器泄漏） | 两主仓各自携带 check-release-clean.sh；KEYWORDS 保留 |
| 测试拆散后回归覆盖 | 各仓独立 vitest；拆仓后跑全量比对（旧仓 1249 = PTH + PTL + infra + 扩展） |
| 共享层 symlink 安装源断 | PTL 仓保留 shared-layer/launcher 机制；独立扩展走 `ptl install --shared` |
| filter-repo 历史迁移出错 | 先 dry-run；旧仓 archive 兜底（历史仍可查） |
| 跨仓文档链接断裂 | 拆分后 docs/README.md 改跨仓索引（仓库名即域名） |
| dev 容器（私有）误入 PTH 仓 | PTH 仓 files 白名单不含 Dockerfile.dev；门禁拦截 |

## 8. 待办确认（拆分实施前）

- [ ] 用户确认 git 历史方案（filter-repo vs 全新 init）
- [ ] 用户确认仓库命名（pi-triple-{ptl,pth,infra,agent-lab}）
- [ ] 用户确认 infra 仓库结构（仓库根即包 vs 保留 packages/infra 层级）

## 9. 开放问题（可后续裁决）

- PTH 的 `src/types/pg.d.ts` 归属（pg 类型声明——随 PTH 仓）
- `docs/superpowers/` 全量文档归属：按主题分仓 vs 只保留各自产品文档（探索/计划/复盘类建议留旧仓归档或按主题复制）
- 根 package.json 的 `pth:dev` 等脚本迁移到对应仓
