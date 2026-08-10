/**
 * /container 命令注册与行为验证（@away_from/extensions-in-container）
 * 参考 test/mailbox-command.test.ts 模式：mock api 验证 registerCommand；
 * docker 调用注入 fake runner（不依赖真实 docker/容器）：
 *   1. 工厂注册 container 命令（默认导出存在）
 *   2. start/verify/status 的 docker argv 正确（单一 argv 透传，无宿主 shell 插值）
 *   3. mount 写 compose dev.volumes（幂等；目录不存在/非法字符拒绝）
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import containerExt from "@away_from/extensions-in-container";

const COMPOSE = "/tmp/container-ext/compose.yaml";

function mockApi() {
  return { registerCommand: vi.fn(), on: vi.fn() };
}

function fakeRun() {
  return vi.fn(async () => ({ code: 0, stdout: "ok", stderr: "" }));
}

/** 最小 compose 夹具：dev 服务 + volumes + environment（模仿真实 docker-compose.yaml 缩进） */
function writeComposeFixture(dir: string): string {
  const file = path.join(dir, "docker-compose.yaml");
  fs.writeFileSync(
    file,
    [
      "services:",
      "  dev:",
      "    build:",
      "      context: .",
      "      dockerfile: Dockerfile.dev",
      "    volumes:",
      "      - dev-home:/home/jovyan",
      "      - ${HOME}/pi-platform:/works/pi-platform:rw",
      "    environment:",
      "      - JUPYTER_TOKEN=${JUPYTER_TOKEN:-}",
      "  other:",
      "    image: busybox",
      "volumes:",
      "  dev-home:",
      "",
    ].join("\n"),
  );
  return file;
}

describe("/container 命令注册", () => {
  it("扩展 default export 存在，工厂注册 container 命令并提供 handler", () => {
    expect(typeof containerExt).toBe("function");
    const api = mockApi();
    containerExt(api);
    const calls = api.registerCommand.mock.calls;
    expect(calls.length).toBe(1);
    const [name, def] = calls[0];
    expect(name).toBe("container");
    expect(typeof def.handler).toBe("function");
    expect(def.description).toContain("container");
  });

  it("start 默认启动 dev 服务（docker compose -f <file> up -d dev）", async () => {
    const run = fakeRun();
    const api = mockApi();
    containerExt(api, { run, composeFile: COMPOSE });
    const [, def] = api.registerCommand.mock.calls[0];
    const notify = vi.fn();
    const code = await def.handler("start", { ui: { notify } });
    expect(run).toHaveBeenCalledWith(["compose", "-f", COMPOSE, "up", "-d", "dev"]);
    expect(code).toBe(0);
    expect(notify).toHaveBeenCalled();
  });

  it("start --name 指定服务；非法服务名拒绝且不调 docker", async () => {
    const run = fakeRun();
    const api = mockApi();
    containerExt(api, { run, composeFile: COMPOSE });
    const [, def] = api.registerCommand.mock.calls[0];
    const notify = vi.fn();
    await def.handler("start --name sandbox", { ui: { notify } });
    expect(run).toHaveBeenCalledWith(["compose", "-f", COMPOSE, "up", "-d", "sandbox"]);

    const bad = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const api2 = mockApi();
    containerExt(api2, { run: bad, composeFile: COMPOSE });
    const [, def2] = api2.registerCommand.mock.calls[0];
    await def2.handler("start --name 'dev; rm -rf /'", { ui: { notify } });
    expect(bad).not.toHaveBeenCalled();
    expect(notify.mock.calls.some(([t, lvl]) => lvl === "warning")).toBe(true);
  });

  it("verify 整条命令作为单一 argv 透传 bash -lc（无宿主 shell 插值，退出码回传）", async () => {
    const run = fakeRun();
    const api = mockApi();
    containerExt(api, { run, composeFile: COMPOSE });
    const [, def] = api.registerCommand.mock.calls[0];
    const notify = vi.fn();
    const cmd = "cd /works/pi-platform && npm test; echo 'hi; rm -rf /'";
    const code = await def.handler(`verify ${cmd}`, { ui: { notify } });
    const argv = run.mock.calls[0][0];
    expect(argv).toEqual(["compose", "-f", COMPOSE, "exec", "-T", "dev", "bash", "-lc", "--", cmd]);
    expect(argv.filter((a: string) => a.includes("rm -rf"))).toHaveLength(1); // 未拆分成宿主 shell
    expect(code).toBe(0);
  });

  it("status 查询 dev 容器（docker compose -f <file> ps dev）", async () => {
    const run = fakeRun();
    const api = mockApi();
    containerExt(api, { run, composeFile: COMPOSE });
    const [, def] = api.registerCommand.mock.calls[0];
    const notify = vi.fn();
    await def.handler("status", { ui: { notify } });
    expect(run).toHaveBeenCalledWith(["compose", "-f", COMPOSE, "ps", "dev"]);
    expect(notify.mock.calls.some(([t]) => String(t).includes("ok"))).toBe(true);
  });

  it("help 输出列出四个子命令", () => {
    const api = mockApi();
    containerExt(api, { run: fakeRun(), composeFile: COMPOSE });
    const [, def] = api.registerCommand.mock.calls[0];
    const notify = vi.fn();
    def.handler("help", { ui: { notify } });
    const text = notify.mock.calls.map(([t]) => String(t)).join("\n");
    expect(text).toContain("/container start");
    expect(text).toContain("/container mount");
    expect(text).toContain("/container verify");
    expect(text).toContain("/container status");
  });
});

describe("/container mount", () => {
  it("挂载目录写入 dev.volumes（幂等：重复挂载不重复写）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "container-mount-"));
    const file = writeComposeFixture(dir);
    const repoDir = path.join(dir, "my-repo");
    fs.mkdirSync(repoDir);

    const api = mockApi();
    containerExt(api, { run: fakeRun(), composeFile: file });
    const [, def] = api.registerCommand.mock.calls[0];
    const notify = vi.fn();
    def.handler(`mount ${repoDir}`, { ui: { notify }, cwd: dir });

    const after1 = fs.readFileSync(file, "utf-8");
    expect(after1).toContain(`      - ${repoDir}:/works/my-repo:rw`);
    expect(after1.split(":/works/my-repo:rw").length - 1).toBe(1);

    // 幂等：再次挂载不重复写
    def.handler(`mount ${repoDir}`, { ui: { notify }, cwd: dir });
    const after2 = fs.readFileSync(file, "utf-8");
    expect(after2.split(":/works/my-repo:rw").length - 1).toBe(1);
    expect(notify.mock.calls.some(([t]) => String(t).includes("已挂载"))).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("目录不存在/含非法字符拒绝，不写文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "container-mount-"));
    const file = writeComposeFixture(dir);
    const original = fs.readFileSync(file, "utf-8");

    const api = mockApi();
    containerExt(api, { run: fakeRun(), composeFile: file });
    const [, def] = api.registerCommand.mock.calls[0];
    const notify = vi.fn();

    def.handler(`mount ${path.join(dir, "nope")}`, { ui: { notify }, cwd: dir });
    expect(fs.readFileSync(file, "utf-8")).toBe(original); // 文件未被改动
    expect(notify.mock.calls.some(([t, lvl]) => lvl === "error")).toBe(true);

    // 换行注入拒绝
    def.handler(`mount evil\n- bad: x`, { ui: { notify }, cwd: dir });
    expect(fs.readFileSync(file, "utf-8")).toBe(original);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("compose 无 dev 服务时报错不写文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "container-mount-"));
    const file = path.join(dir, "docker-compose.yaml");
    fs.writeFileSync(file, "services:\n  other:\n    image: busybox\n");

    const api = mockApi();
    containerExt(api, { run: fakeRun(), composeFile: file });
    const [, def] = api.registerCommand.mock.calls[0];
    const notify = vi.fn();
    def.handler(`mount ${dir}`, { ui: { notify }, cwd: dir });
    expect(notify.mock.calls.some(([t, lvl]) => lvl === "error")).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
