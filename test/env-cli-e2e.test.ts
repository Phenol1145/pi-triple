// env CLI 端到端测试——真实 run.ts 分发路径（spawn pit.ts，不走 dispatchCommand 直调）
//
// Finding #1（Critical，回归）防回归：run.ts env 分支曾对所有 env 子命令无条件
// flattenFlags(flags)，把被 args.ts VALUED_FLAGS 吞掉的 flag（--model 等）重新塞回
// dispatch 参数 → parseEnvPatch(["--model","x"]) 命中"bare 两参"分支生成
// {--model:"x"} → 绕过 execEnvSet 空 patch 防御（commit 50304be）→ 误导性
// "不可写字段: --model"。
//
// 修复：flattenFlags 仅保留给 extension-copy/skill-copy（其 --from/--mode 是 VALUED_FLAGS），
// 其余 env 子命令不再 flatten。本文件两个用例分别锁定修复的两半：
//   1) env set --model x → 空 patch 防御提示（field=value），而非 不可写字段
//   2) env extension-copy --from … → flag 仍到达 dispatch（flatten 未被整体删掉）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

describe("env CLI（真实 run.ts 路径）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ptl-env-cli-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("env set <alias> --model x（flag 被 VALUED_FLAGS 吞掉）→ 空 patch 防御提示，而非 不可写字段: --model", () => {
    const r = runCli(["env", "set", "demo", "--model", "x"], { PI_TRIPLE_HOME: dir, HOME: dir });
    // ok:false → doPrintCommand process.exit(1)
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("field=value");
    expect(r.stdout).toContain("model=qwen3.8-max");
    expect(r.stdout).not.toContain("不可写字段");
  });

  it("env extension-copy 仍收到 --from/--mode（flattenFlags 仅保留给 copy 子命令）", () => {
    // 无 demo 环境：--from demo 若到达 dispatch → "环境 "demo" 不存在"；
    // 若 flatten 被整体删掉 → "未指定 --from 且无默认环境"（可区分）
    const r = runCli(["env", "extension-copy", "e1", "--from", "demo", "--mode", "引用"], { PI_TRIPLE_HOME: dir, HOME: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('环境 "demo" 不存在');
    expect(r.stdout).not.toContain("未指定 --from");
  });

  // ─── final fix wave C1：env fork CLI 路由（dispatch print + JSON 双通路） ──

  it("env fork <child> <nosrc>（print）→ 到达 execEnvFork（修复前 UNKNOWN_COMMAND）", () => {
    const r = runCli(["env", "fork", "child", "nosrc"], { PI_TRIPLE_HOME: dir, HOME: dir });
    // ok:false → doPrintCommand process.exit(1)；TENANT_NOT_FOUND 证明 fork 分支已注册
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('环境 "nosrc" 不存在');
    expect(r.stdout).not.toContain("未知命令");
  });

  it("env fork --json → 走 JSON router（修复前 UNSUPPORTED_JSON）", () => {
    const r = runCli(["env", "fork", "child", "nosrc", "--json"], { PI_TRIPLE_HOME: dir, HOME: dir });
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("TENANT_NOT_FOUND");
  });

  it("env fork happy path：create src → fork child（print）→ fork grandchild --json（两位置参数顺序）", () => {
    const created = runCli(["env", "create", "src"], { PI_TRIPLE_HOME: dir, HOME: dir });
    expect(created.status).toBe(0);

    const r = runCli(["env", "fork", "child", "src"], { PI_TRIPLE_HOME: dir, HOME: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("环境已派生");
    expect(r.stdout).toContain("child");

    const j = runCli(["env", "fork", "grandchild", "child", "--json"], { PI_TRIPLE_HOME: dir, HOME: dir });
    expect(j.status).toBe(0);
    // migrate() 的 banner/源目录提示会先打到 stdout（pre-existing，print 通路同样如此），
    // JSON 信封是最后一行——取最后非空行解析
    const lines = j.stdout.trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.alias).toBe("grandchild");
  });
});
