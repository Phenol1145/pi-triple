/**
 * workflow extension — pit-flow 的 pi 会话内接口
 *
 * /flow 命令（人用）+ LLM 工具（agent 用）+ 人工门通知
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn as spawnAsync } from "node:child_process";
import { syncRun, asyncRun, hasPitCli } from "./runner.js";
import { GateWatcher } from "./gate-watch.js";
import type { FlowMeta } from "./gate-watch.js";

// ── 声明 pi 类型 ─────────────────────────────────────────────

type AutocompleteItem = { value: string; label: string; description?: string };

// ── helpers ──────────────────────────────────────────────────

function flowsRoot(): string {
  return path.join(
    process.env.PI_TRIPLE_HOME ?? path.join(os.homedir(), ".pi-triple"),
    "data",
    "flows",
  );
}

/** 读 meta.json 目录列表（前缀匹配用） */
function listRunIds(): string[] {
  const dir = flowsRoot();
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 读取单个 run 的 meta.json */
function loadMeta(runDir: string): FlowMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** 读取最新 checkpoint 的 output（用于 flow_status 工具） */
function lastCheckpointOutput(runDir: string): { nodeId: string; output: string } | null {
  const cpDir = path.join(runDir, "checkpoints");
  if (!fs.existsSync(cpDir)) return null;
  try {
    const files = fs.readdirSync(cpDir)
      .filter((f) => f.endsWith(".json"))
      .sort() // 按名称排序 = 按序号排序
      .reverse();
    for (const f of files) {
      const cp = JSON.parse(fs.readFileSync(path.join(cpDir, f), "utf-8"));
      if (cp.output != null) {
        return { nodeId: cp.nodeId, output: String(cp.output) };
      }
    }
  } catch { /* ok */ }
  return null;
}

/** 读取 pending.json 的 nodeId */
function pendingNodeId(runDir: string): string | undefined {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(runDir, "pending.json"), "utf-8"));
    return p.nodeId;
  } catch {
    return undefined;
  }
}

/** input 对象转为 k=v args */
function inputToArgs(input?: Record<string, unknown>): string[] {
  if (!input) return [];
  return Object.entries(input).map(([k, v]) => {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}=${val}`;
  });
}

// ── 扩展入口 ──────────────────────────────────────────────────

export default function (pi: any) {
  // 检查 pit CLI
  if (!hasPitCli()) {
    process.stderr.write("[workflow] pit CLI 不可用，workflow 扩展需要 pit\n");
    return;
  }

  // ── ctx 缓存 ─────────────────────────────────────────────
  let cachedCtx: any = null;
  const watcher = new GateWatcher();

  pi.on("session_start", (_event: any, ctx: any) => {
    cachedCtx = ctx;

    // 启动人工门监听
    watcher.setNotify((runId, name, message) => {
      try {
        cachedCtx?.ui.notify(message, "warning");
      } catch { /* ok */ }
    });
    watcher.start();
  });

  pi.on("session_shutdown", () => {
    watcher.stop();
  });

  // ── /flow 命令 ──────────────────────────────────────────

  const subCmds: AutocompleteItem[] = [
    { value: "run", label: "run <file> [k=v...]", description: "启动工作流（异步）" },
    { value: "approve", label: "approve <id> [备注]", description: "批准人工门（异步）" },
    { value: "reject", label: "reject <id> [备注]", description: "驳回人工门（异步）" },
    { value: "resume", label: "resume <id>", description: "恢复失败工作流（异步）" },
    { value: "ls", label: "ls", description: "列出工作流" },
    { value: "status", label: "status <id>", description: "运行状态" },
    { value: "show", label: "show <id>", description: "完整输出 + state" },
    { value: "graph", label: "graph <id>", description: "查看当前图" },
    { value: "set", label: "set <id> <path> <value>", description: "热修改图/状态（点路径）" },
    { value: "edit", label: "edit <id>", description: "$EDITOR 编辑整图（tmux 新窗口）" },
    { value: "validate", label: "validate <file>", description: "校验 flow.json" },
    { value: "rm", label: "rm <id>", description: "删除工作流" },
  ];

  pi.registerCommand("flow", {
    description: "pit-flow 工作流引擎 — 多 agent 编排",
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.trim().split(/\s+/);

      // 第一级：子命令名
      if (parts.length <= 1) {
        const p = parts[0] ?? "";
        const filtered = subCmds.filter((c) => c.value.startsWith(p));
        return filtered.length > 0 ? filtered : null;
      }

      // 第二级：runId 前缀（approve/reject/resume/status/show/graph/rm/set/edit）
      const cmd2 = parts[0];
      if (["approve", "reject", "resume", "status", "show", "graph", "rm", "set", "edit"].includes(cmd2!) && parts.length === 2) {
        const p2 = parts[1] ?? "";
        const ids = listRunIds().filter((id) => id.startsWith(p2));
        return ids.length > 0 ? ids.slice(0, 10).map((id) => ({ value: id.slice(0, 8), label: id.slice(0, 8) })) : null;
      }

      return null;
    },
    handler: async (args: string, ctx: any) => {
      const [cmd, ...rest] = args.trim().split(/\s+/);
      const cwd = ctx.cwd ?? process.cwd();

      if (!cmd) {
        ctx.ui.notify("/flow run|ls|status|show|approve|reject|resume|graph|set|edit|validate|rm", "info");
        return;
      }

      // ── set：value 含空格需重组（id path value...） ──
      if (cmd === "set") {
        const [id, dotPath, ...valueParts] = rest;
        if (!id || !dotPath || valueParts.length === 0) {
          ctx.ui.notify("用法: /flow set <id> <path> <value>\n例: /flow set 5b59cbcf nodes.2.prompt 新 prompt", "warning");
          return;
        }
        const r = syncRun(["flow", "set", id, dotPath, valueParts.join(" ")], cwd);
        const text = r.stdout.trim() || r.stderr.trim();
        ctx.ui.notify(text || (r.ok ? "已设置" : "设置失败"), r.ok ? "info" : "error");
        return;
      }

      // ── edit：tmux 新窗口跑 pit flow edit（$EDITOR 交互） ──
      if (cmd === "edit") {
        const id = rest[0];
        if (!id) { ctx.ui.notify("用法: /flow edit <id>", "warning"); return; }
        if (process.env.TMUX) {
          const { spawnSync: sp } = await import("node:child_process");
          sp("tmux", ["new-window", "-n", `flow-edit-${id.slice(0, 8)}`, "pit", "flow", "edit", id]);
          ctx.ui.notify(`已在 tmux 新窗口打开编辑器（flow-edit-${id.slice(0, 8)}）`, "info");
        } else {
          ctx.ui.notify(`请在 shell 中运行: pit flow edit ${id}`, "warning");
        }
        return;
      }

      // ── 同步命令 ──────────────────────────────
      if (["ls", "status", "show", "graph", "validate", "rm"].includes(cmd)) {
        const r = syncRun(["flow", cmd, ...rest], cwd);
        const text = r.stdout.trim() || r.stderr.trim();
        if (text) ctx.ui.notify(text, r.ok ? "info" : "error");
        else ctx.ui.notify(r.ok ? `${cmd} 完成` : `${cmd} 失败`, r.ok ? "info" : "error");
        return;
      }

      // ── 异步命令 ──────────────────────────────
      asyncRun(["flow", cmd, ...rest], cwd,
        (runId) => {
          if (runId) {
            ctx.ui.notify(`\x1b[32m✅ 工作流已启动: ${runId}…\x1b[0m\n/flow status ${runId}`, "info");
          }
        },
        (ok, stderr) => {
          if (!ok && stderr.trim()) {
            ctx.ui.notify(`\x1b[31m❌ 工作流失败: ${stderr.slice(0, 300)}\x1b[0m`, "error");
          }
        },
      );
    },
  });

  // ── LLM 工具 ──────────────────────────────────────────────

  // flow_run
  pi.registerTool({
    name: "flow_run",
    label: "Start Workflow",
    description: "启动一个 pit-flow 工作流。返回 runId，后续用 flow_status 查状态。",
    promptSnippet: "Start a workflow from a flow.json file (e.g. examples/pr-review/flow.json) with optional key=value input",
    promptGuidelines: ["Use flow_run when the user asks to run a multi-step agent workflow. After launching, check back with flow_status periodically."],
    parameters: {
      file: { type: "string", description: "flow.json 文件路径" },
      input: { type: "object", description: "输入参数（optional，如 {pr: 'title'}）" },
      required: ["file"],
    },
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, _ctx: any) {
      const file = params.file as string;
      const input = params.input as Record<string, unknown> | undefined;
      const args = ["flow", "run", file, ...inputToArgs(input)];
      const cwd = _ctx.cwd ?? process.cwd();

      return new Promise((resolve) => {
        let runId = "";
        const child = spawnAsync("pit", args, { cwd, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" });

        const stderrChunks: string[] = [];
        child.stdout?.on("data", (chunk: string) => {
          const match = chunk.match(/启动:\s*\S+\s+\(([0-9a-f]{8})…/);
          if (match && !runId) runId = match[1]!;
        });
        child.stderr?.on("data", (chunk: string) => { stderrChunks.push(chunk); });
        child.on("error", (err: Error) => {
          resolve({ content: [{ type: "text", text: `工作流启动失败: ${err.message}` }], details: { runId: "", error: err.message } });
        });
        child.on("close", (code: number) => {
          if (runId) {
            resolve({ content: [{ type: "text", text: `工作流已启动 (${runId}…)\n实时状态: /flow status ${runId}` }], details: { runId } });
          } else {
            resolve({ content: [{ type: "text", text: `启动失败: ${stderrChunks.join("").slice(0, 500)}` }], details: { error: stderrChunks.join("") } });
          }
        });
      });
    },
  });

  // flow_status
  pi.registerTool({
    name: "flow_status",
    label: "Workflow Status",
    description: "查询工作流运行状态。返回 status（running/waiting_human/done/failed）、当前节点、步骤数、最新输出。",
    promptSnippet: "Check the status and latest output of a running workflow by runId",
    promptGuidelines: ["Use flow_status to check on a workflow you launched. Read lastOutput to understand what the workflow is doing. If status is waiting_human, inform the user that human approval is needed via /flow approve <id>."],
    parameters: {
      runId: { type: "string", description: "工作流 runId（前缀即可）" },
      required: ["runId"],
    },
    async execute(_toolCallId: string, params: any) {
      const inputId = params.runId as string;
      // 前缀匹配
      const ids = listRunIds().filter((id) => id.startsWith(inputId));
      if (ids.length === 0) {
        return { content: [{ type: "text", text: `工作流 "${inputId}" 不存在` }], details: { error: "NOT_FOUND" } };
      }
      if (ids.length > 1) {
        return { content: [{ type: "text", text: `"${inputId}" 匹配 ${ids.length} 个工作流: ${ids.map((i) => i.slice(0, 8)).join(", ")}` }], details: { error: "AMBIGUOUS" } };
      }

      const runDir = path.join(flowsRoot(), ids[0]!);
      const meta = loadMeta(runDir);
      if (!meta) {
        return { content: [{ type: "text", text: `无法读取工作流 "${inputId}" 的元数据` }], details: { error: "META_READ_ERROR" } };
      }

      const last = lastCheckpointOutput(runDir);
      const pending = pendingNodeId(runDir);

      return {
        content: [{
          type: "text",
          text: [
            `工作流: ${meta.name}`,
            `状态: ${meta.status}`,
            `步骤: ${meta.stepCount ?? 0}`,
            `当前节点: ${pending ?? (last?.nodeId ?? "—")}`,
            `最新输出: ${last?.output?.slice(0, 300) ?? "(无)"}`,
          ].join("\n"),
        }],
        details: {
          runId: meta.runId,
          name: meta.name,
          status: meta.status,
          stepCount: meta.stepCount,
          currentNode: pending ?? last?.nodeId ?? null,
          lastOutput: last?.output ?? "",
        },
      };
    },
  });

  // flow_ls
  pi.registerTool({
    name: "flow_ls",
    label: "List Workflows",
    description: "列出所有工作流运行记录（running/waiting/done/failed）",
    promptSnippet: "List all pit-flow workflow runs",
    promptGuidelines: ["Use flow_ls to show the user a summary of all workflow runs. For a specific run's details, use flow_status."],
    parameters: {},
    async execute() {
      const dir = flowsRoot();
      if (!fs.existsSync(dir)) {
        return { content: [{ type: "text", text: "暂无工作流" }], details: { runs: [] } };
      }

      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
      const runs: Record<string, unknown>[] = [];

      for (const entry of entries) {
        const meta = loadMeta(path.join(dir, entry.name));
        if (meta) {
          runs.push({
            runId: meta.runId,
            name: meta.name,
            status: meta.status,
            createdAt: meta.createdAt,
            stepCount: meta.stepCount ?? 0,
          });
        }
      }

      runs.sort((a, b) => (b.createdAt as number) - (a.createdAt as number));

      if (runs.length === 0) {
        return { content: [{ type: "text", text: "暂无工作流" }], details: { runs: [] } };
      }

      const lines = runs.map((r) =>
        `${r.status === "running" ? "🟢" : r.status === "waiting_human" ? "🟡" : r.status === "done" ? "✅" : "🔴"} ${r.name}  [${(r.runId as string).slice(0, 8)}]  ${r.status}  ${r.stepCount} steps`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { runs },
      };
    },
  });
}
