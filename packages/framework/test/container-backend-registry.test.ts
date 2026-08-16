import { describe, it, expect } from "vitest";
import {
  getBackend,
  registerContainerBackend,
  type ContainerBackend,
} from "../src/containers/backend.js";
import "../src/containers/docker-backend.js"; // 模块专项 ④：自注册 docker 实现

describe("容器后端注册表（模块专项 ④）", () => {
  it("实现模块自注册后 getBackend(docker) 返回 DockerBackend", async () => {
    const backend = await getBackend("docker");
    expect(backend.kind).toBe("docker");
  });

  it("注册表支持扩展点注入（podman/k8s 占位）", async () => {
    const fake: ContainerBackend = {
      kind: "podman",
      up: async () => {},
      down: async () => {},
      status: async () => ({ backend: "podman", healthy: true, services: [] }),
      logs: async () => "",
      restart: async () => {},
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      available: async () => true,
    };
    registerContainerBackend("podman", async () => fake);
    await expect(getBackend("podman")).resolves.toBe(fake);
  });

  it("未注册后端明确报错（扩展点语义）", async () => {
    await expect(getBackend("k8s" as never)).rejects.toThrow(/尚未实现/);
  });
});
