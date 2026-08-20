/**
 * container-runtime-adapter-contract.test.ts —— R1 适配器接口契约。
 *
 * 协议只要求五个成员 + 三个只读方法；消费方不得触碰任何写操作。
 * 本测试用假适配器跑一遍「监控消费面」，证明契约形状可独立实现。
 */

import { describe, expect, it } from "vitest";
import type {
  ContainerRuntimeAdapter,
  ContainerRuntimeStats,
  ContainerRuntimeSummary,
} from "../src/container-runtime/types.js";

function makeFakeAdapter(overrides: Partial<ContainerRuntimeAdapter> = {}): ContainerRuntimeAdapter {
  const stats: ContainerRuntimeStats = {
    id: "c1",
    cpu: { onlineCpus: 4, totalUsage: 1000, systemUsage: 4000 },
    memory: { usageBytes: 1024, limitBytes: 2048 },
    network: { rxBytes: 10, txBytes: 20 },
  };
  const list: ContainerRuntimeSummary[] = [{
    id: "c1",
    names: ["/worker-a"],
    image: "busybox:1.36",
    state: "running",
    status: "Up 1 hour",
    health: "healthy",
  }];
  let statsCalls = 0;
  return {
    id: "docker",
    socket: "/tmp/fake.sock",
    probe: async () => ({ available: true }),
    version: async () => ({ id: "docker", version: "27.3.1", apiVersion: "1.47" }),
    features: { events: false, health: true },
    listContainers: async () => list,
    inspectContainer: async (id) => ({
      id,
      name: "/worker-a",
      image: "busybox:1.36",
      createdAt: 1_700_000_000_000,
      startedAt: 1_700_000_100_000,
      finishedAt: null,
      running: true,
      exitCode: null,
    }),
    getContainerStats: async (id) => {
      statsCalls += 1;
      return {
        ...stats,
        id,
        cpu: {
          ...stats.cpu,
          totalUsage: stats.cpu.totalUsage + statsCalls * 100,
          systemUsage: stats.cpu.systemUsage + statsCalls * 400,
        },
      };
    },
    ...overrides,
  };
}

/** 监控消费面：只允许读 R1 契约成员，写方法不存在于接口。 */
async function collectReadonlySnapshot(adapter: ContainerRuntimeAdapter) {
  const [probe, version, containers] = await Promise.all([
    adapter.probe(),
    adapter.version(),
    adapter.listContainers(),
  ]);
  const first = containers[0]!;
  const [inspect, stats] = await Promise.all([
    adapter.inspectContainer(first.id),
    adapter.getContainerStats(first.id),
  ]);
  return {
    id: adapter.id,
    socket: adapter.socket,
    features: adapter.features,
    probe,
    version,
    containers,
    inspect,
    stats,
  };
}

describe("ContainerRuntimeAdapter 契约（R1）", () => {
  it("五个成员 + 三个只读方法全部可用", async () => {
    const adapter = makeFakeAdapter();
    const snapshot = await collectReadonlySnapshot(adapter);

    expect(snapshot.id).toBe("docker");
    expect(snapshot.socket).toBe("/tmp/fake.sock");
    expect(snapshot.features).toEqual({ events: false, health: true });
    expect(snapshot.probe).toEqual({ available: true });
    expect(snapshot.version).toMatchObject({ id: "docker", version: "27.3.1" });
    expect(snapshot.containers).toHaveLength(1);
    expect(snapshot.inspect.running).toBe(true);
    expect(snapshot.stats.cpu.onlineCpus).toBe(4);
    expect(snapshot.stats.memory.usageBytes).toBe(1024);
  });

  it("stats 只携带累计计数器（百分比由调用方两帧差计算）", async () => {
    const adapter = makeFakeAdapter();
    const prev = await adapter.getContainerStats("c1");
    const next = await adapter.getContainerStats("c1");
    const cpuPct = (next.cpu.totalUsage - prev.cpu.totalUsage) / (next.cpu.systemUsage - prev.cpu.systemUsage) * next.cpu.onlineCpus * 100;
    expect(cpuPct).toBe(100);
  });

  it("probe 失败仍返回结构化结果而不是抛异常", async () => {
    const adapter = makeFakeAdapter({ probe: async () => ({ available: false, reason: "no daemon" }) });
    await expect(adapter.probe()).resolves.toEqual({ available: false, reason: "no daemon" });
  });
});
