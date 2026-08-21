# Phase 3 拆仓报告：pi-triple-ptl

> 日期：2026-08-21 · 状态：✅ 本地拆仓 + 独立门禁全绿 + GitHub 已推送；⏳ npm 依赖真实发布后做最终 `npm ci` 复验
> 设计依据：[repo-split-v15-design.md](./repo-split-v15-design.md)

## 1. 产物

- 本地仓库：`/Users/anzhize/pi-triple-ptl`（git filter-repo 2.47.0，两轮过滤）
- 拆分历史：主仓 210 个 commit（先按 PTL 路径保留，再 `--invert-paths` 剔除 PTH/deps 测试）
- PTL 仓 HEAD：`8fb5ed8`（Phase 3 根脚手架 + Phase 4 README/文档收尾）
- GitHub：https://github.com/Phenol1145/pi-triple-ptl（PUBLIC，已推送）

## 2. 仓库形态

```
pi-triple-ptl
├── packages/framework     # @away_from/framework@1.5.0 · bin: ptl（bin/pit.js wrapper）
├── packages/mailbox       # @away_from/mailbox@1.5.0
├── packages/dev-container # @away_from/dev-container@1.5.0
├── extensions             # _shared / pit-control / pit-providers + mailbox/dev-container symlink
├── config                 # settings.json · SYSTEM.md
├── deploy                 # Dockerfile.dev（PTL 工具容器）· pth.deployment.json（容器拓扑契约）
├── test                   # PTL-only：48 unit + 1 integration + 8 根测试 + 包内测试
├── docs/ptl               # PTL 文档 + docs-manifest.json
└── package.json / tsconfig / vitest.config.ts / README / .github/ci.yml
```

关键落位：

- 依赖 `@away_from/shared@^1.5.0` / `@away_from/infra@^1.5.0`（npm 版本，无 file: 跨仓直连）。
- framework 自行声明 react/ink/string-width/zod 运行时依赖。
- **安装体验**：framework `bin/ptl → bin/pit.js`（已提交 wrapper），npm 安装期即可链接
  `node_modules/.bin/ptl`；`postinstall: npm run build` 保证 dist 就绪；未构建时 wrapper 经 tsx 直跑源码。
- 版本解析 `resolveRepoRootPackageJson` 接受新根名 `@away_from/pi-triple-ptl`（旧名兼容）。
- 测试无 PTH 源码依赖：PTL 仓代码/test 无 `src/pth` / `@away_from/pth-*` import（文档注释与边界检查器的路径常量除外）；
  安装依赖树不含任何 pth 包（PTL 调 PTH 只经 `pth` CLI / HTTP API）。

## 3. 验证（PTL 仓内）

| 门禁 | 结果 |
|---|---|
| fresh clone `npm ci`（本地 registry 模拟已发布 deps） | ✅ 13s，`node_modules/.bin/ptl --version` → `ptl v1.5.0` |
| `npm run lint` | ✅ framework/mailbox/dev-container tsc + product-boundaries 0 + docs-links |
| `npm run build` | ✅ framework → mailbox → dev-container |
| `npm test`（full） | ✅ **64 files / 464 tests / 464 pass / 0 fail / 0 skip** |
| PTL 安装不触发 PTH 源码下载 | ✅ package.json / lockfile 无 pth 包，无 git 依赖 |

## 4. 拆分时修正 / 决策

- **shared 模板自包含**（deps `358bcc0`）：`AGENTS.md.tpl` 从仓库根迁入
  `packages/shared/docs/ptl/templates` 并加入 package `files`；`AGENTS_TPL_PATH` 改为包内解析。
  tgz sha256 更新：`324d2500…baf`（infra 不变）。另新增 `exports["./tmux"]` 子路径供测试 mock。
- **测试归属矩阵补全**：`bridge-client.test.ts`（framework/test）归 PTH → pth-console/test；
  `session-pool-redis / slot-binding / engine-lifecycle / storage / ptl-kernel-bridge / zz-agent-dbg`
  归 PTH；`shared-barrel.test.ts` 归 deps；`repo-split-manifest.test.ts` 留在旧仓（其语义依赖全路径存在）。
- PTL 清单移除误入的 `ext-check.ts / gen-project-map.ts`（PTH 脚本，归 pth 仓）。
- `pi-scan.test.ts` 改用 `@away_from/shared/tmux` 子路径 mock（npm dist 无法按相对路径 mock）。
- `check-product-boundaries.ts` walk 对缺失扫描根容错（PTL 仓无 `src/`）。
- `docs/ptl/architecture.md` 顶层 ARCHITECTURE.md 链接改指旧仓 GitHub 归档路径。
- PTL compose/dev 容器与 release 脚本从 copyBoth 原样带入；release 通道改写留 Phase 4。

## 5. 发布状态

GitHub ✅ 已推送（origin/main = `8fb5ed8`）。

npm 依赖先决条件（待用户执行，deps 仓 `358bcc0` 已就绪）：

```bash
cd /Users/anzhize/pi-triple-deps
npm publish ./packages/shared --access public
npm publish ./packages/infra --access public
```

发布后 PTL 仓最终复验：

```bash
cd /Users/anzhize/pi-triple-ptl
npm ci && npm run lint && npm run build && npm test
```

PTH 仓 `package-lock.json` 已同步新 shared integrity；真实发布后 PTH 同样可 `npm ci` 复验。
