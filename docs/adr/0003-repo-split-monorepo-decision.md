# ADR-0003：维持 pi-platform 单仓（PTL/PTH 不拆仓）

> 日期：2026-08-15 · 状态：已接受 · 前置：ADR-0001、`docs/superpowers/specs/2026-08-08-repo-split-design.md`

## 背景

- `docs/superpowers/specs/2026-08-08-repo-split-design.md`（2026-08-08，状态"已批准但未执行"）计划把 pi-platform 拆为 `pi-triple-ptl`、`pi-triple-pth`、`pi-triple-infra`、`pi-triple-agent-lab` 等新仓，并归档旧仓。
- ADR-0001（2026-08-15）已解除 PTL/PTH 的前后端关系：PTH 是自耦自然语言解释器，PTL 是基于 pi 的多环境共存平台，PTL 通过 PTH CLI 调用 PTH。
- 该范围变化使"仓库拆分是产品边界的前提"不再成立：两个产品已经通过 CLI 解耦，边界可以在单仓内用目录与发布门禁表达。
- 重新裁决的原因：
  - 产品边界不再依赖仓库边界，拆仓不再是 PTL/PTH 解耦的必要条件；
  - 单仓避免迁移成本、多仓 CI/发布矩阵和跨仓版本对齐成本；
  - 包级边界已经存在（`packages/*` 与 `src/pth`），维持单仓改动最小、成本最低。

## 决定

- **维持 pi-platform 单仓**，不执行 `2026-08-08-repo-split-design.md` 中的仓库拆分方案。
- PTL/PTH 边界由 **`packages/` 目录与 `src/pth/` 目录** 加上 **发布门禁** 区分：PTL 侧以 `packages/`（framework、mailbox、dev-container 等）为主，PTH 侧以 `src/pth` 核心（及其专属 `packages/pth-memory`、`packages/pth-sandbox`）为主。
- `docs/superpowers/specs/2026-08-08-repo-split-design.md` 标记为历史参考（文首已加标注行），其拆分结论不再作为实施目标，正文与拓扑图保持原样。
- 不新增仓库、不迁移 git 历史、不归档 pi-platform。

## 保留的机制

- **npm workspaces**：`packages/*`（shared、infra、framework、mailbox、dev-container、pth-memory、pth-sandbox）继续作为包级边界，与 `src/pth` 核心代码并存于单仓。
- **目录级测试分组**：`test/pth-*`（PTH 测试）与 `test/unit`、`test/integration` 及根级 e2e（PTL/平台测试）继续按目录区分，测试随产品边界走。
- **构建顺序**：`npm run build` 按依赖序构建 `pth-memory → pth-sandbox → shared → infra → framework → mailbox → dev-container → 根 tsconfig（src/pth）`，单仓内保持这一顺序不变。
- **Docker 单一部署链**：继续使用 `deploy/docker-compose.yaml` 与 `deploy/pth.deployment.json`（postgres、redis、pi-platform、sandbox 四个服务源）；不拆出独立的 PTH 部署仓或 PTL 部署仓。
- **发布门禁**：`scripts/check-release-clean.sh` 继续作为发行包洁净检查，确保 dev 容器与用户痕迹不进发行包。

## 未来触发条件（何时重新考虑拆分）

- PTL 与 PTH 出现**独立发布需求**（独立版本线、独立 npm 包或独立发版节奏），单仓发版互相拖累。
- 需要**仓库级权限隔离**：例如 PTH 核心只允许少数人合入，而 PTL 扩展允许更宽的贡献权限。
- PTL 消费 PTH CLI 的**发布稳定性要求**提升：需要跨仓库锁定并验证 PTH CLI 的发布版本，单仓目录门禁无法满足。
- 扩展（如 agent-lab）需要**独立仓库 / 独立 npm 发布与版本化**，且不适合继续在单仓内按目录管理。
- 单仓全量构建 / 测试 / CI 时间不可接受，且按目录拆分能够显著改善。

## Consequences

**正面**

- 零迁移成本：不执行拆仓、不迁移 git 历史、不维护多仓 CI/发布矩阵。
- 包级边界已能支撑产品解耦；PTL 通过 PTH CLI 调用 PTH 的现状不要求仓库分离。
- 单一构建 / 测试 / 发布链，回归成本最低，与现有 npm workspaces 和 Docker 部署链保持一致。

**负面**

- 单仓发版粒度较粗；未来若需要独立发布 PTH，必须额外引入目录级门禁与分别打包机制。
- 仓库级权限隔离不可得：PTH 核心与 PTL 扩展处于同一 git 权限域。
- `2026-08-08-repo-split-design.md` 的已批准结论不再实施，需要本 ADR 明确其历史参考地位。

**不变量**

- 全量 `npm test`、`npm run lint`、`npm run build` 保持绿线。
- 后续任何实施按阶段独立提交；本次决策只新增/标注文档，不修改源码。
- 旧 spec 保留历史：`docs/superpowers/specs/2026-08-08-repo-split-design.md` 保留原文，仅在文首标注历史参考，不修改其结论。
