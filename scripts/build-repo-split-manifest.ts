#!/usr/bin/env node
/**
 * scripts/build-repo-split-manifest.ts —— PTL/PTH 三仓拆分的路径清单与命令迁移映射。
 *
 * 运行：npm run repo-split:manifest
 * 产物：docs/repo-split-v15-manifest.json（设计阶段，不移动任何文件）。
 * 与 filter-repo 的 --path 过滤配合；copyBoth/copyAll 表示拆分后按需复制。
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outFile = fileURLToPath(new URL("../docs/repo-split-v15-manifest.json", import.meta.url));

export interface RepoSplitRepo {
  name: string;
  npmScope: string;
  workspaces: string[];
  filterRepoPaths: string[];
  /** 二次 filter-repo 需从该仓剔除的路径（用于避免两仓共享同一目录时重复入库）。 */
  postFilterRemovePaths: string[];
  copyBoth: string[];
  notes: string;
}

export interface CommandMigration {
  from: string;
  to: string;
  impl: string;
  kind: "pth" | "ptl-local";
}

const DEPS_UNIT_TESTS = [
  "test/unit/model-router.test.ts",
  "test/unit/platform.test.ts",
  "test/unit/sdk-paths.test.ts",
  "test/unit/session-backend.test.ts",
  "test/unit/session-state.test.ts",
  "test/unit/warnings.test.ts",
  "test/unit/workspace-manager.test.ts",
];

const PTH_UNIT_TESTS = [
  "test/unit/agent-engine-recover.test.ts",
  "test/unit/agent-engine-session-persist.test.ts",
  "test/unit/async-iterable-bridge.test.ts",
  "test/unit/bench.test.ts",
  "test/unit/bridge-client-errors.test.ts",
  "test/unit/bridge-manifest.test.ts",
  "test/unit/components-store.test.ts",
  "test/unit/concept-design.test.ts",
  "test/unit/docker-monitor-alerts.test.ts",
  "test/unit/docker-monitor-charts.test.ts",
  "test/unit/docker-monitor-metrics.test.ts",
  "test/unit/docker-monitor-pth-client.test.ts",
  "test/unit/docker-monitor-ring-buffer.test.ts",
  "test/unit/docker-monitor-runtime-aggregator.test.ts",
  "test/unit/docker-monitor-server.test.ts",
  "test/unit/docker-monitor-ui-state.test.ts",
  "test/unit/events-webhook.test.ts",
  "test/unit/f-wp2-integration.test.ts",
  "test/unit/f-wp3-integration.test.ts",
  "test/unit/f-wp5-integration.test.ts",
  "test/unit/fallback-requests.test.ts",
  "test/unit/hot-reloader-inject.test.ts",
  "test/unit/hub-debug.test.ts",
  "test/unit/hub-observe.test.ts",
  "test/unit/operator-console-action-registry.test.ts",
  "test/unit/operator-console-config-view.test.ts",
  "test/unit/operator-console-contracts.test.ts",
  "test/unit/operator-console-debug-view.test.ts",
  "test/unit/operator-console-memory-view.test.ts",
  "test/unit/operator-console-n30-proxy.test.ts",
  "test/unit/operator-console-preview-store.test.ts",
  "test/unit/operator-console-server.test.ts",
  "test/unit/operator-console-session.test.ts",
  "test/unit/operator-console-work-actions.test.ts",
  "test/unit/pth-metrics-redis.test.ts",
  "test/unit/pth-programs-routes.test.ts",
  "test/unit/pth-programs-store.test.ts",
  "test/unit/ptl-bridge-manifest.test.ts",
  "test/unit/ptl-bridge-ustar.test.ts",
  "test/unit/reserved-session.test.ts",
  "test/unit/sandbox-bash-forward.test.ts",
  "test/unit/sandbox-degraded.test.ts",
  "test/unit/session-pool.test.ts",
  "test/unit/tool-platform.test.ts",
];

const DEPS: RepoSplitRepo = {
  name: "pi-triple-deps",
  npmScope: "@away_from",
  workspaces: ["packages/shared", "packages/infra"],
  filterRepoPaths: ["packages/shared", "packages/infra", ...DEPS_UNIT_TESTS],
  postFilterRemovePaths: [],
  copyBoth: ["tsconfig.base.json"],
  notes: "发布 @away_from/shared 与 @away_from/infra；两个主仓都以 npm 依赖消费，不再 file: 直连。",
};

const PTH: RepoSplitRepo = {
  name: "pi-triple-pth",
  npmScope: "@away_from",
  workspaces: ["packages/pth-memory", "packages/pth-sandbox", "packages/pth-console"],
  filterRepoPaths: [
    "src/pth",
    "src/types",
    "packages/pth-memory",
    "packages/pth-sandbox",
    "packages/pth-console",
    "extensions/pth-tasks",
    "toolstore",
    "deploy/Dockerfile",
    "deploy/Dockerfile.dev",
    "deploy/docker-compose.yaml",
    "deploy/docker-compose.dev.yaml",
    "deploy/docker-monitor",
    "deploy/professional-runtime-lock.json",
    "deploy/container-runtime-lock.json",
    "deploy/pth.deployment.json",
    "deploy/.env.pth.secrets.example",
    "config/pth-trust-policy.example.json",
    "test/pth-architecture",
    "test/pth-application",
    "test/pth-bootstrap",
    "test/pth-catalog",
    "test/pth-composition",
    "test/pth-config",
    "test/pth-contracts",
    "test/pth-execution",
    "test/pth-gateway",
    "test/pth-kernel-assembly",
    "test/pth-kernel-execution",
    "test/pth-kernel-extensions",
    "test/pth-kernel-interpreter",
    "test/pth-kernel-storage",
    "test/pth-knowledge-intake",
    "test/pth-observability",
    "test/pth-professional",
    "test/pth-runner",
    "test/pth-tasking",
    "test/browser",
    "test/helpers.ts",
    "test/setup.ts",
    ...PTH_UNIT_TESTS,
    "docs/pth",
    "scripts/pth-cli.ts",
    "scripts/check-pth-boundaries.ts",
    "scripts/check-pth-config.ts",
    "scripts/accept-n28-feasibility.ts",
    "scripts/accept-n29-minimal-intake.ts",
    "scripts/accept-n30-runtime-observatory.ts",
    "scripts/accept-n33-operator-console.ts",
    "scripts/accept-v13.ts",
    "scripts/accept-v14.ts",
    "scripts/eval-k5-pilot.ts",
    "scripts/eval-n28-feasibility.ts",
    "scripts/eval-n29-minimal-intake.ts",
    "scripts/eval-n30-runtime-observatory.ts",
    "scripts/eval-n33-operator-console.ts",
    "scripts/eval-v13-professional-computing.ts",
    "scripts/eval-v14-operator-console-ux.ts",
    "scripts/v13-authority-gates.ts",
    "scripts/v14-real-probes.ts",
    "scripts/n14-p3-tool-promotion.ts",
    "scripts/n28-feasibility-fixture.ts",
    "scripts/n28-feasibility-harness.ts",
    "scripts/n28-structure-snapshot.ts",
    "scripts/n29-canary-gpe-wikipedia.ts",
    "scripts/n33-real-probes.ts",
    "scripts/pth-boundaries-core.ts",
    "scripts/pth-boundaries.baseline.json",
    "scripts/pth-intake-subscribe.ts",
    "scripts/r6-composition-acceptance.ts",
    "scripts/seed-k5-pilot.ts",
    "scripts/seed-tool-reg.ts",
    "scripts/seed-wiki.ts",
    "scripts/drain.sh",
    "scripts/check-sandbox-env.sh",
    "scripts/monitor-docker-resources.sh",
    "scripts/sandbox-debug-entry.sh",
    "scripts/supervisor.sh",
    "scripts/update-professional-runtime-lock.ts",
    "scripts/verify-clean-sandbox-build.sh",
    "scripts/copy-framework-web-assets.mjs",
    "scripts/adjudicate-tensions.ts",
    "scripts/import-mcp-bundle.ts",
    "scripts/build-discipline-catalog.ts",
  ],
  postFilterRemovePaths: [],
  copyBoth: [
    "tsconfig.base.json",
    "scripts/build-docs-manifest.ts",
    "scripts/check-doc-links.ts",
    "scripts/lane-worktrees.sh",
  ],
  notes: "bin: pth → packages/pth-console/dist/cli.js（承接原 ptl hub 的 PTH 交互面 + launcher/web）。Dockerfile.dev 需复制并裁剪为 PTH dev 专用。",
};

const PTL: RepoSplitRepo = {
  name: "pi-triple-ptl",
  npmScope: "@away_from",
  workspaces: ["packages/framework", "packages/mailbox", "packages/dev-container"],
  filterRepoPaths: [
    "packages/framework",
    "packages/mailbox",
    "packages/dev-container",
    "extensions/_shared",
    "extensions/pit-control",
    "extensions/pit-providers",
    "config/settings.json",
    "config/SYSTEM.md",
    "deploy/Dockerfile.dev",
    "test/unit",
    "test/integration",
    "test/concurrent-wal.test.ts",
    "test/env-cli-e2e.test.ts",
    "test/env-fork.test.ts",
    "test/env.test.ts",
    "test/extension-copy.test.ts",
    "test/fixwave-stop-json.test.ts",
    "test/stop-all.test.ts",
    "test/telemetry.test.ts",
    "docs/ptl",
    "scripts/ext-check.ts",
    "scripts/gen-project-map.ts",
    "scripts/check-release-clean.sh",
  ],
  postFilterRemovePaths: [...PTH_UNIT_TESTS, ...DEPS_UNIT_TESTS],
  copyBoth: [
    "tsconfig.base.json",
    "scripts/build-docs-manifest.ts",
    "scripts/check-doc-links.ts",
    "scripts/lane-worktrees.sh",
    "scripts/release-pack.sh",
    "scripts/release.sh",
  ],
  notes: "bin: ptl。原 ptl hub 语法退役；PTH 交互面全部迁移到 pth 仓；ptl stack 承接容器运维。test/unit 目录整体搬入后用 postFilterRemovePaths 二次 filter-repo 剔除 PTH/deps 文件。",
};

export const COMMAND_MIGRATIONS: CommandMigration[] = [
  { from: "ptl hub submit <dir>", to: "pth program submit <dir>", impl: "framework/src/bridge/submit.ts → pth-console/src/commands/submit.ts", kind: "pth" },
  { from: "ptl hub run <name> [k=v…]", to: "pth program run <name> [k=v…]", impl: "bridge/run.ts → pth-console/src/commands/run.ts", kind: "pth" },
  { from: "ptl hub programs", to: "pth program list", impl: "bridge/programs.ts → pth-console/src/commands/programs.ts", kind: "pth" },
  { from: "ptl hub request/requests", to: "pth request / pth requests", impl: "bridge/request.ts → pth-console/src/commands/request.ts", kind: "pth" },
  { from: "ptl hub respond <id> <dir>", to: "pth respond <id> <dir>", impl: "bridge/respond.ts → pth-console/src/commands/respond.ts", kind: "pth" },
  { from: "ptl hub observe …", to: "pth observe …", impl: "bridge/observe.ts → pth-console/src/commands/observe.ts", kind: "pth" },
  { from: "ptl hub debug …", to: "pth debug …", impl: "bridge/debug.ts → pth-console/src/commands/debug.ts", kind: "pth" },
  { from: "ptl hub bench …", to: "pth bench …", impl: "bridge/bench.ts → pth-console/src/commands/bench.ts", kind: "pth" },
  { from: "ptl hub job …", to: "pth job …", impl: "bridge/jobs.ts → pth-console/src/commands/jobs.ts", kind: "pth" },
  { from: "ptl hub console …", to: "pth console …", impl: "bridge/console.ts → pth-console/src/commands/console.ts", kind: "pth" },
  { from: "ptl hub lineage …", to: "pth lineage …", impl: "bridge/lineage.ts → pth-console/src/commands/lineage.ts", kind: "pth" },
  { from: "ptl hub trigger …", to: "pth trigger …", impl: "bridge/trigger.ts → pth-console/src/commands/trigger.ts", kind: "pth" },
  { from: "ptl hub kernel tasks/batch/templates/wait/status", to: "pth kernel …", impl: "bridge/kernel.ts → pth-console/src/commands/kernel.ts", kind: "pth" },
  { from: "ptl hub dev <dir>", to: "ptl program dev <dir>", impl: "bridge/dev.ts+pipe.ts → framework/src/program-dev/", kind: "ptl-local" },
  { from: "ptl hub deploy/status/logs/upgrade/exec", to: "ptl stack deploy/status/logs/upgrade/exec", impl: "bridge/containers.ts → framework/src/stack/", kind: "ptl-local" },
];

export function buildRepoSplitManifest() {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    decisions: {
      topology: ["pi-triple-deps", "pi-triple-pth", "pi-triple-ptl", "pi-platform (archive)"],
      interactionPackage: "@away_from/pth-console（PTH 仓唯一交互面；pth bin 在此包）",
      ptlHub: "retired——PTH 交互迁 pth，PTL 容器/本地能力迁 ptl stack / ptl program dev",
      gitHistory: "git filter-repo 按 pathFilters 拆仓，旧仓 archive 兜底",
    },
    repos: { deps: DEPS, pth: PTH, ptl: PTL },
    commandMigrations: COMMAND_MIGRATIONS,
    crossRepoVersions: {
      "pi-triple-pth dependencies": ["@away_from/shared@^1.5.0", "@away_from/infra@^1.5.0"],
      "pi-triple-ptl dependencies": ["@away_from/shared@^1.5.0", "@away_from/infra@^1.5.0"],
      "PTL→PTH": "无包依赖；全部经 pth CLI / HTTP API（协议 v1）",
    },
    phases: [
      "Phase 0（本仓）：pth-console 承载 pth CLI 全部交互命令；ptl hub 只留迁移提示；ptl stack/program dev 落位；测试迁移。",
      "Phase 1：filter-repo 拆 pi-triple-deps；发布 shared/infra 1.5.x。",
      "Phase 2：filter-repo 拆 pi-triple-pth；依赖切 npm 版本；构建/测试/试运行全绿。",
      "Phase 3：filter-repo 拆 pi-triple-ptl；依赖切 npm 版本；ptl 安装/测试全绿。",
      "Phase 4：旧仓 GitHub archive；三仓 README/CI/门禁各自独立。",
    ],
  };
}

const invokedDirectly = process.argv[1]?.endsWith("build-repo-split-manifest.ts") ?? false;
if (invokedDirectly) {
  const manifest = buildRepoSplitManifest();
  writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `repo-split-manifest: deps ${DEPS.filterRepoPaths.length} paths · pth ${PTH.filterRepoPaths.length} · ptl ${PTL.filterRepoPaths.length} · commands ${COMMAND_MIGRATIONS.length}`,
  );
}
