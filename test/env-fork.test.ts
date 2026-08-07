// env fork 测试：配方引用复制（model/skills/extensions 继承，实体不复制）+ 独立性
// 适配说明（相对 brief 示例）：fresh 配置只有 "local" 模板，"src" 不存在，
// execEnvSet 对不存在环境返回 ok:false 而非抛错（静默 no-op），故先 execEnvCreate("src")。
// 数据隔离同 test/env.test.ts（PI_TRIPLE_HOME + HOME → tmpdir，migrate 源目录不存在则空跑）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execEnvCreate, execEnvFork, execEnvSet, execEnvShow } from "../packages/framework/src/env.js";

describe("env fork", () => {
  let dir: string;
  let prevHome: string | undefined;
  let prevTripleHome: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ptl-env-fork-"));
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

  it("fork copies recipe references (not entities)", async () => {
    const created = await execEnvCreate("src");
    expect(created.ok).toBe(true);
    await execEnvSet("src", { model: "qwen", skills: ["s1"], extensions: ["e1"] });
    const r = await execEnvFork("forked", "src");
    expect(r.ok).toBe(true);
    const show = await execEnvShow("forked");
    expect(show.data?.recipe?.model).toBe("qwen");
    expect(show.data?.recipe?.skills).toEqual(["s1"]);
    expect(show.data?.recipe?.extensions).toEqual(["e1"]);
  });

  it("forked env is independent (set on fork doesn't affect src)", async () => {
    await execEnvSet("forked", { model: "other" });
    const src = await execEnvShow("src");
    expect(src.data?.recipe?.model).toBe("qwen");
  });
});
