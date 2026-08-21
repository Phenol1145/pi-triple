# Phase 4 收尾报告：三仓独立化 + 旧仓归档

> 日期：2026-08-21 · 状态：✅ 三仓 README/CI/文档索引独立化完成；旧仓已 GitHub archive
> 设计依据：[repo-split-v15-design.md](./repo-split-v15-design.md)

## 1. 三仓最终形态

| 仓库 | GitHub | 门禁 |
|------|--------|------|
| `pi-triple-deps` | https://github.com/Phenol1145/pi-triple-deps | `npm ci && npm run lint && npm run build && npm test`（12 files / 73 tests） |
| `pi-triple-pth` | https://github.com/Phenol1145/pi-triple-pth | `npm ci && npm run lint && npm run build && npm test`（283 files / 2572 tests / 0 fail / 9 skip；CI 排除需本地工具链容器的 professional `.integration` 垂直切片） |
| `pi-triple-ptl` | https://github.com/Phenol1145/pi-triple-ptl | `npm ci && npm run lint && npm run build && npm test`（64 files / 464 tests / 0 fail） |

## 2. 本阶段动作

- **README 独立化**（按生态 README 共性结构重写）：徽章/一句定位/Quick Start 前置/模块表/ASCII 架构图/Development/Roadmap/Documentation；三仓相对链接零坏链。
- **文档索引独立化**：
  - deps：新增 `docs/README.md` 索引；
  - pth：新增 `docs/README.md` + 生成 `docs/docs-manifest.json`（96 docs）；历史 superpowers/CONTEXT 链接显式 `--allow` 指旧仓归档；
  - ptl：新增 `docs/README.md` + 更新 `docs/docs-manifest.json`（6 docs）。
- **文档去残留**：`ptl hub` 退役语法在现行文档中全部改为 `pth …` / `ptl stack …` / `ptl program …`；`@pi-triple/shared` 旧包名清除；`module-ownership` 更新为三仓归属。
- **CI 独立化**：三仓均有 `.github/workflows/ci.yml`（deps 新增）；pth CI 测试步骤排除依赖本地工具链容器的 professional `.integration` 垂直切片（本地全量回归仍全跑）。
- **产品边界修正**：mailbox/dev-container 归 PTL 产品面（`check-product-boundaries.ts` 同步三仓）；pth/ptl 边界检查均 0 违规。
- **GitHub 元数据**：三仓 PUBLIC + 独立 description/topics。
- **旧仓归档**：`Phenol1145/pi-triple` 已 archive（只读；历史/设计/拆分报告可读），README 置顶三仓指引。

## 3. 验收对照

- ✅ 三仓各自 `npm ci && npm run build && npm test` 全绿（deps 73 / pth 2572 / ptl 464；pth/ptl 已用本地 registry 做 fresh-clone `npm ci` 复验）
- ✅ PTL 安装不触发 PTH 源码下载（依赖树零 pth 包）
- ✅ `pth up` 仍能从 PTH 仓拉起全栈（Phase 2 已验；本阶段未改部署）
- ✅ 旧仓 archive 后历史/发布记录可读

## 4. 遗留（用户执行）

- npm 真实发布 `@away_from/shared@1.5.0` / `@away_from/infra@1.5.0`（deps 仓 `358bcc0`，
  需 Granular Access Token）。发布后三仓 `npm ci` 即可直接走公开 registry（lockfile 已钉 npmjs）。
- GitHub Actions 首次全绿将在上述发布后自然达成。
