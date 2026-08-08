import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // 测试始终跑源码（无需先 build）：@pi-triple/shared 的 exports.default 指向 dist
      "@pi-triple/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@pi-triple/infra": fileURLToPath(new URL("./packages/infra/src/index.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 90_000,
    // testcontainers 并发资源竞争（Docker Desktop 多 postgres 并发启动超时）——
    // 实测 maxWorkers=4 稳定全绿（1390 tests）；并发过高时 testcontainers 偶发启动失败
    maxWorkers: 4,
    poolOptions: {
      maxWorkers: 4,
    },
  },
});
