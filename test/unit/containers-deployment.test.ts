import { describe, it, expect } from "vitest";
import { parseDeployment, loadDeployment } from "../../packages/framework/src/containers/deployment.js";
import { renderCompose } from "../../packages/framework/src/containers/docker-backend.js";

const SAMPLE = {
  name: "pth-test",
  services: {
    app: {
      build: ".",
      ports: ["3000:3000"],
      env: { LOG_LEVEL: "info", PTH_BATCH_TICK_MS: "${PTH_BATCH_TICK_MS:-1000}" },
      volumes: ["workspaces:/data/workspaces"],
      limits: { cpus: 2, memory: "2G", pids: 512 },
      dependsOn: ["db"],
    },
    db: { image: "postgres:16-alpine", internal: false },
    sandbox: { image: "sandbox:latest", internal: true },
  },
  networks: { default: {}, "sandbox-internal": { internal: true } },
};

describe("容器抽象——部署描述 schema", () => {
  it("合法描述解析通过（服务/env/卷/限额/依赖）", () => {
    const dep = parseDeployment(SAMPLE);
    expect(dep.name).toBe("pth-test");
    expect(dep.services.app.env?.LOG_LEVEL).toBe("info");
    expect(dep.services.app.limits?.memory).toBe("2G");
    expect(dep.services.sandbox.internal).toBe(true);
  });

  it("非法描述拒绝（缺 name）", () => {
    expect(() => parseDeployment({ services: {} })).toThrow();
  });

  it("pth.deployment.json 为合法描述（现有拓扑声明化——事实源）", async () => {
    // 2026-08-14 重组：容器构建归拢 deploy/——部署描述随迁
    const dep = await loadDeployment("deploy/pth.deployment.json");
    expect(dep.services["pi-platform"]).toBeDefined();
    expect(dep.services.sandbox.internal).toBe(true);
    expect(dep.services["pi-platform"].env?.["DATABASE_URL"]).toContain("postgres");
  });
});

describe("容器抽象——docker 后端渲染", () => {
  it("渲染 compose：服务/环境/卷/限额/内部网络", () => {
    const yaml = renderCompose(parseDeployment(SAMPLE));
    expect(yaml).toContain("name: pth-test");
    expect(yaml).toContain("app:");
    expect(yaml).toContain("LOG_LEVEL=\"info\"");
    expect(yaml).toContain("workspaces:/data/workspaces");
    expect(yaml).toContain('cpus: "2"');
    expect(yaml).toContain("memory: 2G");
    expect(yaml).toContain("depends_on:");
    // sandbox 内部网络契约
    expect(yaml).toContain("pth-test_sandbox-internal:");
    expect(yaml).toContain("internal: true");
  });

  it("env 插值透传（${} 不 JSON 化）", () => {
    const yaml = renderCompose(parseDeployment(SAMPLE));
    expect(yaml).toContain("PTH_BATCH_TICK_MS=${PTH_BATCH_TICK_MS:-1000}");
    expect(yaml).toContain('LOG_LEVEL="info"');
  });
});
