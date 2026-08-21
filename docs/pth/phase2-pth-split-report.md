# Phase 2 拆仓报告：pi-triple-pth

> 日期：2026-08-21 · 状态：✅ 本地拆仓 + 独立门禁全绿（未创建 GitHub 远端）
> 设计依据：[repo-split-v15-design.md](./repo-split-v15-design.md)

## 1. 产物

- 本地仓库：`/Users/anzhize/pi-triple-pth`（git filter-repo 2.47.0 按路径历史拆分）
- 拆分历史：主仓 801 个 commit 按 PTH 路径过滤保留
- PTH 仓 HEAD：`89c0346`（Phase 2 根脚手架 + PTH-only 部署裁剪）

## 2. 仓库形态

```
pi-triple-pth
├── src/pth                 # PTH 主服务（kernel/runner/gateway/execution）
├── src/cli/pth-cli.ts      # pth 命令入口（根 tsc 编译 → dist/cli/pth-cli.js）
├── packages/pth-memory     # @away_from/pth-memory@1.5.0（新增 pg 依赖）
├── packages/pth-sandbox    # @away_from/pth-sandbox@1.5.0（infra 切 npm ^1.5.0）
├── packages/pth-console    # @away_from/pth-console@1.5.0（shared 切 npm ^1.5.0；
│                           #   barrel 导出 commands/launcher/web——CLI 不再穿透包源码）
├── deploy                  # PTH-only Dockerfile / Dockerfile.dev / compose（4 服务）/ monitor / locks
├── extensions/pth-tasks · toolstore · docs/pth · test/pth-*
└── package.json / tsconfig(.base).json / vitest.config.ts / README / .github/ci.yml
```

关键落位：

- 根 `bin.pth` → `dist/cli/pth-cli.js`（随根 tsc 编译，shebang 保留）；`scripts/pth-cli.ts` 删除。
- pth-console 通过 `exports`/barrel 暴露全部交互面；根 CLI 只 import `@away_from/pth-console`。
- 依赖声明 `@away_from/shared@^1.5.0` / `@away_from/infra@^1.5.0`（npm 版本，无 file: 跨仓直连）。
- `package-lock.json` 全部 resolved 指向 `registry.npmjs.org`（本地验证经本地 registry，锁文件已回写公开地址）。
- compose 项目名 `pi-triple-pth`，镜像 `pi-triple-pth:latest` / `pi-triple-pth-sandbox:latest`——与旧仓运行栈隔离。

## 3. 验证（PTH 仓内）

| 门禁 | 结果 |
|---|---|
| `npm install`（本地 registry 模拟已发布 deps） | ✅ 606 packages |
| `npm run lint` | ✅ tsc ×4 + web typecheck + pth-boundaries 0 + pth-config + product-boundaries 0 + docs-links |
| `npm run build` | ✅ pth-memory → pth-sandbox → pth-console → vite(14 assets) → 根 tsc |
| `npm test`（full） | ✅ **276 files / 2525 tests / 2516 pass / 0 fail / 9 skip** |
| `pth` bin 冒烟 | ✅ help / roles / config / templates / status / submit |
| Playwright | ✅ **4/4**（operator console 五页基线） |
| Docker build | ✅ `pi-triple-pth` + `pi-triple-pth-sandbox`（经 `NPM_CONFIG_REGISTRY` build-arg） |
| `pth up` | ✅ postgres/redis healthy → pi-platform/sandbox healthy → operator token 种入 → /health + /api/v1/self/version |
| 任务回归 | ✅ `pth submit "回归探针" --role developer` → pending → 任务列表可见（无 LLM 密钥环境按策略 rejected） |

## 4. 拆分时修正 / 决策

- `pth` bin 采用根仓编译方案（用户已选）：`src/cli/pth-cli.ts` 随根 tsc 出 `dist/cli/pth-cli.js`；pth-console 保持可发布库。
- `pth tags` 原为未实现占位（tsx 直跑不 typecheck 从未暴露），编译化时移除该命令。
- vitest 必须 `server.deps.inline: [/@away_from\/(infra|shared)/]`：npm dist 若被 external，`vi.mock("@earendil-works/pi-coding-agent")` 无法穿透 infra 的 SDK 边界（主仓 alias 源码天然内联）。
- `scripts/check-product-boundaries.ts` 进入 PTH 仓并修正 tsx 直跑判定（原 `import.meta.url === argv[1]` 在 tsx 下不触发）。
- 部署裁剪：删除 compose 中 PTL 的 dev/jupyter 服务；`deploy/Dockerfile.dev` 重写为 PTH 专用 node dev 镜像；sandbox 镜像移除 framework/ptl 内嵌，保留 pi 自修改入口。
- jupyter 专业测试跨仓通道：旧仓 compose jupyter 服务新增 `${HOME}/pi-triple-pth:/works/pi-triple-pth` 挂载（过渡期），PTH 测试 pathForJupyter 按 REPO_ROOT 翻译。
- docs-links：对仍指向旧仓/archive 的历史链接（superpowers/CONTEXT/TODO/repo-split-manifest 等 15 条）在 PTH 仓 lint 中显式 `--allow`，不物理复制旧仓文档。
- 本地工具链容器 `v13-asm-toolchain` 重建时补充 `pi-triple-pth` 挂载，并恢复 Lean 用户工具链/Mathlib 模板/QE 6.7/CP2K 2023.1/PSL 赝势（Debian bookworm apt 版本恰与 `professional-runtime-lock.json` 一致）。

## 5. 发布命令（待用户执行）

```bash
cd /Users/anzhize/pi-triple-pth

# GitHub（需先在 github.com 创建 pi-triple-pth 空仓库）
git remote add origin git@github.com:Phenol1145/pi-triple-pth.git
git push -u origin main
```

依赖先决条件：`@away_from/shared@1.5.0` 与 `@away_from/infra@1.5.0` 已 npm publish（见 Phase 1 报告）；发布前 `npm ci` 即按公开 registry 解析。
