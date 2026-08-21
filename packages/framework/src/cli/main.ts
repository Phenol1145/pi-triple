/**
 * ptl/main — banner / 分组帮助 / 上手指引 / 单命令详情 渲染
 */

import { getPtlVersion } from "../version.js";

export function printBanner(): void {
  console.log("");
  console.log("  \x1b[36m\x1b[1mPi-Triple\x1b[0m \x1b[2mv" + getVersion() + "\x1b[0m");
  console.log("");
}

export function getVersion(): string { return getPtlVersion(); }

// ─── 分组帮助 ───────────────────────────────────────────────

interface HelpGroup { title: string; intro?: string; commands: Array<[string, string]>; }

const HELP_GROUPS: HelpGroup[] = [
  {
    title: "日常使用", intro: "会话生命周期",
    commands: [
      ["start [--template x] [--bg --name n]", "启动会话（日常主操作）"],
      ["pi", "原生前台启动（无 tmux）"],
      ["attach|switch|detach|stop <name>", "会话管理"],
      ["ls", "列出会话"],
    ],
  },
  {
    title: "可视化 TUI", intro: "低门槛可视化操作",
    commands: [
      ["tui dashboard", "系统总控面板"],
      ["tui lab [--template x] [--global]", "开发面板"],
    ],
  },
  {
    title: "Operator Console", intro: "仅监听 127.0.0.1 的本地 Web 控制台",
    commands: [
      ["operator [--port p] [--no-open]", "启动 PTL Operator Console（一次性 bootstrap 链接）"],
    ],
  },
  {
    title: "模板与配置",
    commands: [
      ["template ls|new|rm|rename", "模板管理"],
      ["config get|set|unset|init", "配置管理"],
    ],
  },
  {
    title: "会话与追踪", intro: "纸带（session）与状态追踪（trace）",
    commands: [
      ["session ls|show|fork|clone|transfer|branch|tree|resume|attach|stop", "纸带操作（会话）"],
      ["restore [name…]", "按注册表恢复会话（重启后重建 + resume 原纸带）"],
      ["trace ls|show|timeline <agent>", "状态追踪（credit 变化）"],
    ],
  },
  {
    title: "容器运维与本地程序调试",
    commands: [
      ["stack deploy [--rebuild]", "容器部署（声明式描述 → docker 后端）"],
      ["stack status [--service <s>]", "容器服务状态"],
      ["stack logs <service> [--tail n]", "容器日志"],
      ["stack upgrade", "重建镜像 + 重启"],
      ["stack exec <service> -- <cmd>", "容器内执行命令"],
      ["program dev <dir>", "本地调试 agent 程序（pi 原生会话）"],
    ],
  },
  {
    title: "PTH 交互", intro: "已迁移到 pth CLI",
    commands: [
      ["（shell）pth submit | program | request | observe | …", "PTH 任务/程序/回退请求/观测"],
    ],
  },
  {
    title: "Agent",
    commands: [
      ["agent run|clean", "agent 实例"],
    ],
  },
  {
    title: "系统与维护",
    commands: [
      ["onboard", "首次导引向导"],
      ["status | doctor", "健康检查"],
      ["update", "更新本体"],
      ["install | remove", "安装/卸载扩展"],
      ["migrate", "迁移扩展到当前模板"],
      ["shared status|init", "共享层"],
      ["help [cmd] | version", "帮助 / 版本"],
    ],
  },
];

export function printHelp(): void {
  printBanner();
  console.log("  用法: ptl <command> [options]");
  console.log("");
  for (const g of HELP_GROUPS) {
    const intro = g.intro ? `  \x1b[2m— ${g.intro}\x1b[0m` : "";
    console.log(`  \x1b[1m${g.title}\x1b[0m${intro}`);
    for (const [cmd, desc] of g.commands) {
      console.log(`    ${cmd.padEnd(42)} \x1b[2m${desc}\x1b[0m`);
    }
    console.log("");
  }
  console.log("  \x1b[2m选项: --template <alias|uuid>  --project <name>  --model <model>\x1b[0m");
  console.log("  \x1b[2m详情: ptl help <cmd>   示例: ptl help start\x1b[0m");
  console.log("");
}

// ─── 上手指引（裸 ptl）──────────────────────────────────────

export function printGettingStarted(): void {
  printBanner();
  console.log("  首次使用？   \x1b[36mptl onboard\x1b[0m");
  console.log("  日常开发？   \x1b[36mptl start\x1b[0m");
  console.log("  可视化？     \x1b[36mptl tui dashboard\x1b[0m");
  console.log("  查看全部？   \x1b[36mptl help\x1b[0m");
  console.log("");
}

// ─── 命名空间帮助 ───────────────────────────────────────────

const NAMESPACE_HELP: Record<string, Array<[string, string]>> = {
  tui: [
    ["tui dashboard", "系统总控面板"],
    ["tui lab [--template x] [--global]", "开发面板"],
  ],
  hub: [
    ["hub", "已退役——PTH 交互请使用 `npm run pth -- <cmd>`"],
    ["pth program submit/run/list", "agent 程序提交/运行/列表"],
    ["pth request(s)/respond/observe/debug", "回退请求/观测/调试"],
    ["pth bench/job/console/lineage/trigger/kernel", "PTH 运维与监督"],
    ["ptl program dev <dir>", "本地程序调试（不再经 hub）"],
    ["ptl stack deploy/status/logs/upgrade/exec", "容器运维（不再经 hub）"],
  ],
  program: [
    ["program dev <dir> [pi args…]", "本地调试 agent 程序（pi 原生会话）"],
  ],
  stack: [
    ["stack deploy [--backend docker] [--rebuild]", "部署（build + up）"],
    ["stack status [--service <s>]", "服务状态"],
    ["stack logs <service> [--tail n]", "日志"],
    ["stack upgrade", "重建镜像 + 重启"],
    ["stack exec <service> -- <cmd…>", "容器内命令"],
  ],
  template: [
    ["template ls", "列出模板（别名 + UUID）"],
    ["template new [alias]", "新建模板"],
    ["template rm <alias>", "删除模板"],
    ["template rename <old> <new>", "重命名别名"],
  ],
  config: [
    ["config", "显示当前配置"],
    ["config get <key>", "读取配置项"],
    ["config set <key> <value>", "修改配置项"],
    ["config unset <key>", "删除可选配置项"],
    ["config init", "初始化 pi-triple.json"],
  ],
  agent: [
    ["agent run <template> <task>", "从模板实例化 agent 执行"],
    ["agent clean <agentId>", "清理临时工作区 (--all)"],
  ],
  shared: [
    ["shared status", "查看共享层状态"],
    ["shared init", "初始化共享层"],
  ],
  session: [
    ["session ls [--template x] [--workloop pi]", "列出纸带会话"],
    ["session show <id>", "会话详情"],
    ["session fork|clone <id> [--template x]", "分叉/克隆会话"],
    ["session transfer <id> --template x", "转移会话到其他模板"],
    ["session branch <id> --at <nodeId> [--template x]", "在节点处分支（--list-nodes 列出节点）"],
    ["session tree [--template x]", "会话谱系森林"],
    ["session resume <id> [--name n]", "后台恢复纸带会话"],
    ["session attach <name> | stop <id|name>", "接入/停止会话"],
  ],
  trace: [
    ["trace ls [--template x] [--agent a]", "列出状态追踪"],
    ["trace show <id>", "追踪详情"],
    ["trace timeline <agentId>", "agent 完整轨迹"],
  ],
};

export function printNamespaceHelp(ns: string): void {
  const rows = NAMESPACE_HELP[ns];
  if (!rows) { printHelp(); return; }
  console.log("");
  console.log(`  \x1b[36m\x1b[1mptl ${ns}\x1b[0m`);
  console.log("");
  for (const [cmd, desc] of rows) {
    console.log(`    ${cmd.padEnd(38)} \x1b[2m${desc}\x1b[0m`);
  }
  console.log("");
}

// ─── 单命令详情 ─────────────────────────────────────────────

const COMMAND_HELP: Record<string, { usage: string; desc: string; flags?: Array<[string, string]>; examples?: string[] }> = {
  start: {
    usage: "ptl start [--template x] [--bg --name n] [--model m]",
    desc: "启动 tmux 会话并接入（日常主操作）",
    flags: [["--template <alias|uuid>", "指定模板"], ["--bg", "纯后台不接入"], ["--name <n>", "命名会话"], ["--model <m>", "覆盖模型"]],
    examples: ["ptl start", "ptl start --template dev", "ptl start --bg --name coding"],
  },
  tui: { usage: "ptl tui [dashboard|lab]", desc: "打开可视化 TUI 面板（默认 dashboard）" },
  operator: {
    usage: "ptl operator [--port p] [--host 127.0.0.1] [--no-open]",
    desc: "启动仅监听 127.0.0.1 的 PTL Operator Console（一次性 bootstrap 链接）",
    flags: [["--port <n>", "监听端口（默认随机可用端口）"], ["--host <127.0.0.1>", "只允许 127.0.0.1"], ["--no-open", "不自动打开浏览器，仅打印链接"]],
    examples: ["ptl operator", "ptl operator --port 8787 --no-open"],
  },
  hub: { usage: "ptl hub（已退役）", desc: "PTH 交互迁移到 pth CLI；容器运维用 ptl stack；本地程序调试用 ptl program dev" },
  program: { usage: "ptl program dev <dir> [pi args…]", desc: "本地调试 agent 程序（pi 原生会话加载 systemPrompt + skills）" },
  stack: { usage: "ptl stack <deploy|status|logs|upgrade|exec>", desc: "容器运维（pth.deployment.json → 容器后端）" },
  onboard: { usage: "ptl onboard", desc: "首次导引向导：环境检查→配置→模板→验证" },
  doctor: { usage: "ptl doctor", desc: "完整健康检查 + 交互修复" },
};

export function printCommandHelp(cmd: string): void {
  const entry = COMMAND_HELP[cmd];
  if (!entry) {
    // 命名空间或未知：命名空间有则给命名空间帮助，否则全量帮助
    if (NAMESPACE_HELP[cmd]) { printNamespaceHelp(cmd); return; }
    printHelp();
    return;
  }
  console.log("");
  console.log(`  \x1b[1m${entry.usage}\x1b[0m`);
  console.log(`  \x1b[2m${entry.desc}\x1b[0m`);
  if (entry.flags) {
    console.log("");
    console.log("  选项:");
    for (const [f, d] of entry.flags) console.log(`    ${f.padEnd(28)} \x1b[2m${d}\x1b[0m`);
  }
  if (entry.examples) {
    console.log("");
    console.log("  示例:");
    for (const e of entry.examples) console.log(`    ${e}`);
  }
  console.log("");
}
