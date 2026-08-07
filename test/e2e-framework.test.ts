// 统一端到端测试（framework 全链路）——AI 主会话视角的完整用户旅程：
//   发现环境 → 创建/派生 → 配置 → 隔离扩展 → 跨会话通讯 → 停止（mock 安全）
// 1. env 工作流：create → set → fork → list --json（AI 可编程闭环）
// 2. extension copy：引用模式 + 源码模式（遮蔽）
// 3. mailbox：发送/接收（文件邮箱 tmpdir）
// 4. stop --all（mock 安全——不误杀真实会话）
//
// 全链路真实执行（tmpdir 隔离：PI_TRIPLE_HOME + HOME → tmpdir，不碰真实环境）。
//
// 适配说明（相对 brief 注释）：
// - stop --all 是唯一 mock 段：tmux 会话枚举/杀进程/心跳经 vi.mock 替换（同
//   test/stop-all.test.ts），其余（env/extension-copy/mailbox）全部真实执行。
//   故意不走 CLI spawn 跑 stop --all——子进程无法 mock，会杀真实 tmux 会话。
// - mailbox 用 pitMail 工厂 + mock api（同 test/mailbox-command.test.ts）：会话
//   注册/心跳/文件邮箱全部真实落在 tmpdir；结束时触发 session_shutdown 停
//   watcher（fs.watch 句柄会挂住事件循环）+ 心跳 + 注销。
// - env list --json 走真实 CLI spawn（tsx pit.ts，同 test/env-cli-e2e.test.ts），
//   验证 AI 可编程闭环；stdout 取最后非空行解析（migrate banner 等 pre-existing
//   输出会先打到 stdout）。
// - 共享层实体 e1 在 env create/fork **之后**才创建：linkTemplateToShared 在
//   建环境时会把当时已存在的共享条目自动 symlink 进环境目录，若提前建实体，
//   extension copy 的"引用模式新建 symlink"断言会被共享层自动挂载抢先满足。
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execEnvCreate, execEnvSet, execEnvFork, execEnvList, execEnvShow } from "../packages/framework/src/env.js";
import { execExtensionCopy } from "../packages/framework/src/extension-copy.js";
import { dispatchCommand } from "../packages/framework/src/commands/dispatch.js";
import pitMail from "@pi-triple/mailbox";

// ── stop --all mock（唯一 mock 段）：tmux 会话枚举/杀进程/心跳替换，
//    其余 @pi-triple/shared 函数保留真实实现（importOriginal spread）──
const mocks = vi.hoisted(() => ({
  sessions: [] as { name: string }[],
  killed: [] as string[],
  stopped: [] as string[],
  hasTmux: true,
}));

vi.mock("@pi-triple/shared", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@pi-triple/shared")>();
  return {
    ...mod,
    hasTmux: () => mocks.hasTmux,
    listPtlSessions: () => mocks.sessions,
    killPtlSession: (name: string) => { mocks.killed.push(name); return true; },
    markStopped: (name: string) => { mocks.stopped.push(name); },
  };
});

// ── CLI spawn（env list --json 真实通路）─────────────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const pitEntry = join(repoRoot, "packages", "framework", "src", "pit.ts");

function runCli(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [tsxCli, pitEntry, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

/** stdout 取最后非空行（migrate banner 等 pre-existing 输出在 JSON 信封之前） */
function lastLine(out: string): string {
  const lines = out.trim().split("\n").filter((l) => l.trim().length > 0);
  return lines[lines.length - 1]!;
}

// ── mailbox 会话辅助（pitMail 工厂 + mock api）───────────────────

interface MailSession {
  api: any;
  registered: { name: string; def: any }[];
  events: Record<string, ((...args: any[]) => void)[]>;
}

function makeMailSession(): MailSession {
  const registered: { name: string; def: any }[] = [];
  const events: Record<string, ((...args: any[]) => void)[]> = {};
  const api: any = {
    registerCommand: (name: string, def: any) => registered.push({ name, def }),
    on: (ev: string, cb: (...args: any[]) => void) => { (events[ev] ??= []).push(cb); },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setSessionName: vi.fn(),
    ui: { notify: vi.fn() },
  };
  return { api, registered, events };
}

function shutdownMailSession(s: MailSession): void {
  for (const cb of s.events.session_shutdown ?? []) cb({ reason: "shutdown" });
}

// ── 测试主体 ───────────────────────────────────────────────────

describe("framework 全链路端到端（AI 主会话完整旅程）", () => {
  let dir: string;
  let prevHome: string | undefined;
  let prevTripleHome: string | undefined;
  const activeMails: MailSession[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ptl-e2e-"));
    prevTripleHome = process.env.PI_TRIPLE_HOME;
    process.env.PI_TRIPLE_HOME = dir;
    prevHome = process.env.HOME;
    process.env.HOME = dir; // migrate 源 $HOME/.pi/agent 不存在 → 空跑（同 env.test.ts）
    mocks.sessions = [{ name: "coding" }, { name: "research" }];
  });

  afterAll(async () => {
    for (const s of activeMails) shutdownMailSession(s); // 停 watcher（fs.watch 挂事件循环）
    if (prevTripleHome === undefined) delete process.env.PI_TRIPLE_HOME;
    else process.env.PI_TRIPLE_HOME = prevTripleHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    delete process.env.PI_SESSION_ID;
    delete process.env.PI_SESSION_NAME;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  // ── 1. env 工作流：发现 → create → set → fork ──────────────

  it("env 工作流：发现（list --json）→ create → set → fork（引用继承 + 独立性）", async () => {
    // 发现阶段：fresh 配置只有默认 local（AI 可编程读取当前环境）
    const discovery = runCli(["env", "list", "--json"], { PI_TRIPLE_HOME: dir, HOME: dir });
    expect(discovery.status).toBe(0);
    const dJson = JSON.parse(lastLine(discovery.stdout));
    expect(dJson.ok).toBe(true);
    expect(dJson.data.envs.map((e: any) => e.alias)).toContain("local");

    // create：fresh 空配方
    const created = await execEnvCreate("knowledge");
    expect(created.ok).toBe(true);
    expect(created.data?.alias).toBe("knowledge");

    // set：配方字段（模型 + 技能/扩展引用）
    const setR = await execEnvSet("knowledge", { model: "qwen3.8-max", skills: ["s1"], extensions: ["e1"] });
    expect(setR.ok).toBe(true);

    // fork：配方引用继承（model/skills/extensions），实体不复制
    const forkR = await execEnvFork("research", "knowledge");
    expect(forkR.ok).toBe(true);
    expect(forkR.data?.recipe?.model).toBe("qwen3.8-max");
    expect(forkR.data?.recipe?.skills).toEqual(["s1"]);
    expect(forkR.data?.recipe?.extensions).toEqual(["e1"]);

    // 独立性：改 research 不影响 knowledge
    const setFork = await execEnvSet("research", { model: "other-model" });
    expect(setFork.ok).toBe(true);
    const src = await execEnvShow("knowledge");
    expect(src.data?.recipe?.model).toBe("qwen3.8-max");

    // 进程内 list 兜底（data.envs 机器可读）
    const list = await execEnvList();
    const aliases = list.data?.envs?.map((e: any) => e.alias) ?? [];
    expect(aliases).toContain("knowledge");
    expect(aliases).toContain("research");
  });

  it("env list --json 闭环：变更后可再次编程读取（新增环境 + 配方字段）", async () => {
    const r = runCli(["env", "list", "--json"], { PI_TRIPLE_HOME: dir, HOME: dir });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(lastLine(r.stdout));
    expect(parsed.ok).toBe(true);
    const byAlias = Object.fromEntries(parsed.data.envs.map((e: any) => [e.alias, e]));
    expect(byAlias.knowledge.recipe.model).toBe("qwen3.8-max");
    expect(byAlias.knowledge.recipe.skills).toEqual(["s1"]);
    expect(byAlias.research.recipe.model).toBe("other-model");
    expect(byAlias.research.recipe.extensions).toEqual(["e1"]);
  });

  // ── 2. extension copy：引用模式 + 源码模式（遮蔽）───────────

  it("extension copy：引用模式（symlink）→ 源码模式（实体遮蔽）", async () => {
    // 共享层实体此时才创建（避免 create/fork 时 linkTemplateToShared 抢先挂载）
    const sharedDir = join(dir, "data", "shared");
    await mkdir(join(sharedDir, "extensions", "e1"), { recursive: true });
    await writeFile(join(sharedDir, "extensions", "e1", "index.js"), "// e1 shared entity\n");

    // 引用模式：symlink → shared/extensions/e1（共享，一处修改处处生效）
    const ref = await execExtensionCopy("e1", { from: "research", mode: "reference" });
    expect(ref.ok).toBe(true);
    expect(ref.data?.mode).toBe("reference");
    const envDir = join(dir, "data", "pi-config", ref.data!.envId);
    const target = join(envDir, "extensions", "e1");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(ref.message).toContain("/reload"); // 会话内 /reload 生效提示（spec §5）

    // 源码模式：实体复制遮蔽 symlink（先 unlink 再 cp，独立可改）
    const src = await execExtensionCopy("e1", { from: "research", mode: "源码" });
    expect(src.ok).toBe(true);
    expect(src.data?.mode).toBe("source");
    const ent = await lstat(target);
    expect(ent.isSymbolicLink()).toBe(false);
    expect(ent.isDirectory()).toBe(true);
    expect((await readdir(target))).toContain("index.js");

    // 共享实体保留（复制不移动源），knowledge 环境不受影响（隔离）
    expect(existsSync(join(sharedDir, "extensions", "e1", "index.js"))).toBe(true);
    const knowledgeDir = join(dir, "data", "pi-config");
    const knowledgeId = (await execEnvList()).data?.envs?.find((e: any) => e.alias === "knowledge")?.id;
    let knowledgeHasE1 = false;
    try {
      knowledgeHasE1 = (await readdir(join(knowledgeDir, knowledgeId, "extensions"))).includes("e1");
    } catch { /* extensions 目录不存在 = 无条目 */ }
    expect(knowledgeHasE1).toBe(false);
  });

  // ── 3. mailbox：发送/接收（文件邮箱 tmpdir）──────────────────

  it("mailbox：/mail 发送 → inbox 接收 → accept（文件邮箱 tmpdir，manual 人工网关）", async () => {
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR; // mailbox root 走 PI_TRIPLE_HOME

    try {
      // 会话 A（ai-main 主会话）与会话 B（worker 子会话）：真实注册/心跳/文件邮箱
      process.env.PI_SESSION_ID = "sess-ai-main";
      process.env.PI_SESSION_NAME = "ai-main";
      const a = makeMailSession();
      pitMail(a.api);
      activeMails.push(a);

      process.env.PI_SESSION_ID = "sess-worker";
      process.env.PI_SESSION_NAME = "worker";
      const b = makeMailSession();
      pitMail(b.api);
      activeMails.push(b);

      const [mailA, mailB] = [a.registered[0], b.registered[0]];
      expect(mailA.name).toBe("mail"); // /mail（非 /pit，Task 1 改名收尾）
      const uiA = { notify: vi.fn() };
      const uiB = { notify: vi.fn() };
      const ctxA = { ui: uiA, cwd: dir };
      const ctxB = { ui: uiB, cwd: dir };
      const notifyA = () => uiA.notify.mock.calls.map((c: any[]) => String(c[0])).join("\n");
      const notifyB = () => uiB.notify.mock.calls.map((c: any[]) => String(c[0])).join("\n");

      // 文件分享：A → B（store-and-forward：pending/file-<id>/ + meta.json）
      await mkdir(join(dir, "outbox"), { recursive: true });
      await writeFile(join(dir, "outbox", "report.md"), "# 集成测试报告\n");
      await mailA.def.handler(`share worker ${join(dir, "outbox", "report.md")} --note 调研报告`, ctxA);
      expect(notifyA()).toContain("Shared with worker");

      // B 收件箱列出文件消息（--note 作为预览内容；readPending 读 file-<id>/meta.json——
      // e2e 暴露的集成缺口，packages/mailbox/mailbox.ts 已补）
      mailB.def.handler("inbox", ctxB);
      expect(notifyB()).toContain("(1 pending)");
      expect(notifyB()).toContain("调研报告");

      // B accept 文件消息：复制文件到 ctx.cwd + file-<id>/ 整目录移入 accepted/
      mailB.def.handler("accept 1", ctxB);
      expect(notifyB()).toContain("File copied");
      expect((await readFile(join(dir, "report.md"), "utf-8"))).toContain("集成测试报告");
      const acceptedDir = join(dir, "data", "mailbox", "local", "sess-worker", "accepted");
      expect((await readdir(acceptedDir)).some((f) => f.startsWith("file-"))).toBe(true);

      // 发送：A → B（真实写入 B 的 pending/msg-<id>.json）
      await mailA.def.handler("send worker 帮我跑一下集成测试", ctxA);
      expect(notifyA()).toContain("Sent to worker");

      // B 收件箱：1 条 pending，来自 ai-main
      mailB.def.handler("inbox", ctxB);
      expect(notifyB()).toContain("(1 pending)");
      expect(notifyB()).toContain("ai-main");

      // B 接收（manual 网关：accept 后注入 LLM followUp）
      mailB.def.handler("accept 1", ctxB);
      expect(b.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("帮我跑一下集成测试"),
        expect.objectContaining({ deliverAs: "followUp" }),
      );
      expect(notifyB()).toContain("Accepted from ai-main");

      // 会话注册表：两个会话都在（文件邮箱的会话发现 /mail ps 依据）
      const registryRaw = await readFile(join(dir, "data", "mailbox", "local", "registry.json"), "utf-8");
      const registry = JSON.parse(registryRaw);
      const names = Object.values(registry).map((e: any) => e.name);
      expect(names).toEqual(expect.arrayContaining(["ai-main", "worker"]));
    } finally {
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
      delete process.env.PI_SESSION_ID;
      delete process.env.PI_SESSION_NAME;
    }
  });

  // ── 4. stop --all（mock 安全）──────────────────────────────

  it("stop --all：mock 会话全停，不误杀真实会话", async () => {
    mocks.sessions = [{ name: "coding" }, { name: "research" }];
    mocks.killed = [];
    mocks.stopped = [];
    mocks.hasTmux = true;

    // run.ts 展平形状 dispatchCommand('stop', ['', '--all']) → flags.all
    const r = await dispatchCommand("stop", ["", "--all"]);
    expect(r.ok).toBe(true);
    expect(r.data?.stopped).toEqual(["coding", "research"]);
    expect(mocks.killed).toEqual(["coding", "research"]);
    expect(mocks.stopped).toEqual(["coding", "research"]);

    // 无会话 → 优雅空跑（"无后台会话"，不报用法错）
    mocks.sessions = [];
    const empty = await dispatchCommand("stop", ["", "--all"]);
    expect(empty.ok).toBe(true);
    expect(empty.data?.stopped).toEqual([]);
    expect(empty.message).toContain("无后台会话");

    // tmux 缺失 → TMUX_NOT_INSTALLED（不误报用法错）
    mocks.hasTmux = false;
    const noTmux = await dispatchCommand("stop", ["", "--all"]);
    expect(noTmux.ok).toBe(false);
    expect(noTmux.error?.code).toBe("TMUX_NOT_INSTALLED");
  });
});
