// env 命令族测试：create/list/show/set/rm
// - fresh 创建（空配方，不继承任何预设）
// - 配方读写（TemplateConfig 字段）
// - PI_TRIPLE_HOME 指向 tmpdir 实现数据隔离
// 适配说明：额外把 HOME 指向 tmpdir——execEnvCreate 复用 execTemplateNew 的 migrate 流程，
// 其源目录取 $HOME/.pi/agent，指向 tmp 使其不存在，迁移空跑不拷贝真实数据
// （对齐 test/integration/template-agents-integration.test.ts 的回归测试做法）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execEnvCreate, execEnvList, execEnvShow, execEnvSet, execEnvRm } from "../packages/framework/src/env.js";
import { parseArgs } from "../packages/framework/src/cli/args.js";
import { dispatchCommand } from "../packages/framework/src/commands/dispatch.js";

describe("env commands", () => {
  let dir: string;
  let prevHome: string | undefined;
  let prevTripleHome: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ptl-env-"));
    // 测试用独立 dataDir（env 命令读 config 的 dataDir，pitHome() 读 PI_TRIPLE_HOME）
    prevTripleHome = process.env.PI_TRIPLE_HOME;
    process.env.PI_TRIPLE_HOME = dir;
    prevHome = process.env.HOME;
    process.env.HOME = dir;
  });

  afterAll(async () => {
    if (prevTripleHome === undefined) delete process.env.PI_TRIPLE_HOME;
    else process.env.PI_TRIPLE_HOME = prevTripleHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  });

  it("create makes a fresh env (no preset)", async () => {
    const r = await execEnvCreate("knowledge", {});
    expect(r.ok).toBe(true);
    const list = await execEnvList();
    expect(list.data?.envs?.some((e: any) => e.alias === "knowledge")).toBe(true);
  });

  it("show displays recipe", async () => {
    const r = await execEnvShow("knowledge");
    expect(r.ok).toBe(true);
    expect(r.data?.recipe).toBeDefined();
  });

  it("set modifies recipe field", async () => {
    const r = await execEnvSet("knowledge", { model: "qwen3.8-max" });
    expect(r.ok).toBe(true);
    const show = await execEnvShow("knowledge");
    expect(show.data?.recipe?.model).toBe("qwen3.8-max");
  });

  it("rm removes env", async () => {
    const r = await execEnvRm("knowledge");
    expect(r.ok).toBe(true);
    const list = await execEnvList();
    expect(list.data?.envs?.some((e: any) => e.alias === "knowledge")).toBe(false);
  });

  // Finding #1（Important，静默假阳性）回归：ptl env set knowledge --model qwen3.8-max
  // 时 qwen3.8-max 被 args.ts VALUED_FLAGS（含 model）当 flag 值吞掉、不进 passthrough
  // → parseEnvPatch([]) 空 patch → 旧实现 set 成功但零修改（误导性假阳性）。
  // 防御：execEnvSet 空 patch 必须返回 ok:false + field=value 提示。
  it("set <alias> --model y（flag 形式，值被 CLI 吞掉）→ ok:false + 提示", async () => {
    const parsed = parseArgs(["env", "set", "knowledge", "--model", "qwen3.8-max"]);
    expect(parsed.flags.model).toBe("qwen3.8-max");
    expect(parsed.passthrough).toEqual(["knowledge"]); // 值被 VALUED_FLAGS 吞掉，不进 passthrough
    const r = await dispatchCommand("env", [parsed.subcommand!, ...parsed.passthrough]);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("field=value");
    expect(r.error?.message).toContain("model=qwen3.8-max");
  });

  it("set with empty patch → ok:false + 提示（防御层，环境不存在也先报字段错误）", async () => {
    const r = await execEnvSet("knowledge", {});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_ARGS");
    expect(r.error?.message).toContain("未提供任何字段");
  });
});
