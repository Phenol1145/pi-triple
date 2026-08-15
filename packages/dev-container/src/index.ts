/**
 * Pi-Triple dev-container — @away_from/dev-container
 *
 * /container 命令族（skill 文档 §4.2 接口约定）：
 *   /container start [--name]    启动 dev 容器（docker compose up -d dev）
 *   /container mount <dir>       挂载仓库目录（写 compose dev.volumes，幂等）
 *   /container verify <cmd>      容器内运行验证命令（bash -lc 单一 argv 透传，退出码回传）
 *   /container status            容器状态（docker compose ps dev）
 *
 * 模式（用户裁决）：命令在宿主机注册（薄壳），执行体跑在 dev 容器里。
 * 安全：docker 调用全部 argv 数组（execFile），无宿主 shell 拼接；
 *       服务名白名单正则；mount 目录存在性 + YAML 注入字符拒绝 + tmp+rename 原子写。
 */

import path from "node:path";
import {
  mountDir,
  realRun,
  resolveComposeFile,
  startArgs,
  statusArgs,
  verifyArgs,
  SERVICE_NAME_RE,
  type ContainerOptions,
  type DockerResult,
} from "./dev-container.js";

const USAGE = [
  "\x1b[1m/container — dev 容器命令族\x1b[0m",
  "  /container start [--name <service>]  启动 dev 容器（默认 service=dev）",
  "  /container mount <dir>               挂载目录到 /works/<name>（写 compose dev.volumes）",
  "  /container verify <cmd>              容器内运行验证命令（bash -lc，退出码透传）",
  "  /container status                    容器状态（docker compose ps dev）",
  "  /container help                      本帮助",
  "",
  "示例：/container verify 'cd /works/pi-platform && npm test'",
].join("\n");

const SUBCOMMANDS = [
  { value: "start", label: "start [--name <service>]", description: "启动 dev 容器" },
  { value: "mount", label: "mount <dir>", description: "挂载目录（写 compose volumes）" },
  { value: "verify", label: "verify <cmd>", description: "容器内运行验证命令" },
  { value: "status", label: "status", description: "容器状态" },
  { value: "help", label: "help", description: "帮助" },
];

function formatResult(r: DockerResult, okPrefix: string, failPrefix: string): string {
  const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  const body = out ? `\n${out}` : "";
  if (r.code === 0) return `${okPrefix}${body}`;
  return `${failPrefix}（exit ${r.code}）${body}`;
}

export default function containerExt(api: any /* ExtensionAPI */, opts: ContainerOptions = {}) {
  const composeFile = resolveComposeFile(opts.composeFile);
  const run = opts.run ?? realRun;

  api.registerCommand("container", {
    description: "Pi-Triple dev container — /container 命令族（start/mount/verify/status）封装 dev 容器",
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.trim().split(/\s+/);
      if (parts.length <= 1) {
        const p = parts[0] ?? "";
        const filtered = SUBCOMMANDS.filter((c) => c.value.startsWith(p));
        return filtered.length > 0 ? filtered : null;
      }
      return null;
    },
    handler: async (args: string, ctx: any /* ExtensionCommandContext */) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const argStr = rest.join(" ");

      // ── START ────────────────────────────────────────────
      if (sub === "start") {
        let service = "dev";
        if (rest.length > 0) {
          if (rest[0] !== "--name" || rest.length !== 2) {
            ctx.ui.notify("Usage: /container start [--name <service>]", "warning");
            return;
          }
          service = rest[1];
        }
        if (!SERVICE_NAME_RE.test(service)) {
          ctx.ui.notify(`服务名不合法（仅 [A-Za-z0-9._-]）：${service}`, "warning");
          return;
        }
        const r = await run(startArgs(composeFile, service));
        ctx.ui.notify(formatResult(r, `\x1b[32m✅ dev 容器 ${service} 已启动\x1b[0m`, `\x1b[31m❌ 启动失败（${service}）\x1b[0m`), r.code === 0 ? undefined : "error");
        return r.code;
      }

      // ── MOUNT ────────────────────────────────────────────
      if (sub === "mount") {
        const dirArg = rest[0];
        if (!dirArg || rest.length > 1) {
          ctx.ui.notify("Usage: /container mount <dir>", "warning");
          return;
        }
        const abs = path.resolve(ctx.cwd ?? process.cwd(), dirArg);
        const r = mountDir(composeFile, abs);
        if (!r.ok) {
          ctx.ui.notify(`\x1b[31m❌ 挂载失败：${r.error}\x1b[0m`, "error");
          return 1;
        }
        if (r.already) {
          ctx.ui.notify(`\x1b[33m↻ 已挂载：${r.line}\x1b[0m`);
          return 0;
        }
        ctx.ui.notify(
          `\x1b[32m✅ 已写入 ${composeFile}\x1b[0m\n  ${r.line}\n\x1b[2m运行 /container start 生效（compose 变更将重建 dev 容器）\x1b[0m`,
        );
        return 0;
      }

      // ── VERIFY ───────────────────────────────────────────
      if (sub === "verify") {
        const cmd = argStr.trim();
        if (!cmd) {
          ctx.ui.notify("Usage: /container verify <cmd>", "warning");
          return;
        }
        const r = await run(verifyArgs(composeFile, cmd));
        const out = [r.stdout, r.stderr].filter(Boolean).join("\n");
        if (out) ctx.ui.notify(out);
        if (r.code === 0) ctx.ui.notify("\x1b[32m✅ 验证通过（exit 0）\x1b[0m");
        else ctx.ui.notify(`\x1b[31m❌ 验证失败（exit ${r.code}）\x1b[0m`, "error");
        return r.code;
      }

      // ── STATUS ───────────────────────────────────────────
      if (sub === "status") {
        const r = await run(statusArgs(composeFile));
        ctx.ui.notify(formatResult(r, "\x1b[1m📦 dev 容器状态\x1b[0m", "\x1b[31m❌ 状态查询失败\x1b[0m"), r.code === 0 ? undefined : "error");
        return r.code;
      }

      // ── HELP / 未知 ──────────────────────────────────────
      if (sub === "help" || !sub) {
        ctx.ui.notify(USAGE);
        return;
      }
      ctx.ui.notify(`Unknown subcommand: ${sub}\n\n${USAGE}`, "warning");
    },
  });
}
