import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { KernelPool } from "../../src/sandbox/kernel-pool.js";
import { buildKernelHostApp } from "../../src/sandbox/kernel-host.js";
import type { FastifyInstance } from "fastify";

/**
 * Kernel sandbox 宿主（P5）——池 + 协议单测。
 * 真实 spawn python/bash（本机）；fastify inject 测协议；认证/敏感约束全覆盖。
 */

const SECRET = "test-kernel-secret";

function auth(secret = SECRET) {
  return { authorization: `Bearer ${secret}` };
}

describe("KernelPool（sandbox 侧共享池）", () => {
  it("acquire：新建 python kernel 并执行代码", async () => {
    const pool = new KernelPool({ lang: "python", max: 2 });
    const id = await pool.acquire();
    expect(id).toMatch(/^py-/);
    const r = await pool.execute(id, "x = 6 * 7\n_result = x");
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
    await pool.dispose();
  });

  it("acquire：空闲优先——release 后复用同一 kernel", async () => {
    const pool = new KernelPool({ lang: "python", max: 2 });
    const id1 = await pool.acquire();
    await pool.execute(id1, "carry = 'state-kept'");
    await pool.release(id1);
    const id2 = await pool.acquire();
    expect(id2).toBe(id1); // 空闲优先复用
    const r = await pool.execute(id2, "_result = carry");
    expect(r.value).toBe("state-kept"); // 状态延续
    await pool.dispose();
  });

  it("acquire：容量内新建、满则排队（FIFO）", async () => {
    const pool = new KernelPool({ lang: "bash", max: 1 });
    const id1 = await pool.acquire();
    const wait = pool.acquire(); // 满 → 排队
    let resolved = false;
    wait.then(() => (resolved = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false); // 未释放前不返回
    await pool.release(id1);
    const id2 = await wait;
    expect(id2).toBe(id1); // 排队的拿到释放的
    await pool.dispose();
  });

  it("reset：ns 清命名空间（变量不延续）", async () => {
    const pool = new KernelPool({ lang: "python", max: 1 });
    const id = await pool.acquire();
    await pool.execute(id, "secret_var = 123");
    await pool.reset(id);
    const r = await pool.execute(id, "_result = 'secret_var' in dir()");
    expect(r.value).toBe(false);
    await pool.dispose();
  });

  it("status：inFlight/idle/容量报告", async () => {
    const pool = new KernelPool({ lang: "python", max: 3 });
    await pool.acquire();
    const s = pool.status();
    expect(s.inFlight).toBe(1);
    expect(s.idle).toBe(0);
    expect(s.capacity).toBe(3);
    await pool.dispose();
  });

  it("snapshot：聚合 kernel 状态（变量枚举）", async () => {
    const pool = new KernelPool({ lang: "python", max: 1 });
    const id = await pool.acquire();
    await pool.execute(id, "fib = 75025");
    const snap = await pool.snapshot(id);
    expect(snap.variables.some((v) => v.key === "fib" && v.value === 75025)).toBe(true);
    await pool.dispose();
  });

  it("未知 kernelId → 拒绝", async () => {
    const pool = new KernelPool({ lang: "python", max: 1 });
    await expect(pool.execute("py-nope", "1+1")).rejects.toThrow(/unknown kernel/i);
    await pool.dispose();
  });
});

describe("kernel host 协议（buildKernelHostApp）", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.SANDBOX_SHARED_SECRET = SECRET;
    app = buildKernelHostApp({});
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.SANDBOX_SHARED_SECRET;
  });

  it("认证：无/错 token 拒绝，对 token 通过", async () => {
    const noAuth = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python" } });
    expect(noAuth.statusCode).toBe(401);
    const badAuth = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python" }, headers: auth("wrong") });
    expect(badAuth.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python" }, headers: auth() });
    expect(ok.statusCode).toBe(200);
  });

  it("acquire/execute/reset/release 全链路（python）", async () => {
    const acq = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python" }, headers: auth() });
    expect(acq.statusCode).toBe(200);
    const { kernelId } = acq.json();
    expect(kernelId).toBeTruthy();

    const ex = await app.inject({ method: "POST", url: "/kernel/execute", payload: { kernelId, code: "total = 5050\n_result = total" }, headers: auth() });
    expect(ex.statusCode).toBe(200);
    expect(ex.json().ok).toBe(true);
    expect(ex.json().value).toBe(5050);

    // 敏感约束：execute 带 env 字段 → 400
    const envReq = await app.inject({ method: "POST", url: "/kernel/execute", payload: { kernelId, code: "1", env: { API_KEY: "x" } }, headers: auth() });
    expect(envReq.statusCode).toBe(400);

    const reset = await app.inject({ method: "POST", url: "/kernel/reset", payload: { kernelId }, headers: auth() });
    expect(reset.statusCode).toBe(200);
    const rel = await app.inject({ method: "POST", url: "/kernel/release", payload: { kernelId }, headers: auth() });
    expect(rel.statusCode).toBe(200);
  });

  it("snapshot 端点返回三字段结构", async () => {
    const acq = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python" }, headers: auth() });
    const { kernelId } = acq.json();
    await app.inject({ method: "POST", url: "/kernel/execute", payload: { kernelId, code: "marker = 1" }, headers: auth() });
    const snap = await app.inject({ method: "POST", url: "/kernel/snapshot", payload: { kernelId }, headers: auth() });
    expect(snap.statusCode).toBe(200);
    const body = snap.json();
    expect(body).toHaveProperty("variables");
    expect(body).toHaveProperty("functions");
    expect(body).toHaveProperty("oversized");
    await app.inject({ method: "POST", url: "/kernel/release", payload: { kernelId }, headers: auth() });
  });

  it("status 端点报告池状态", async () => {
    const st = await app.inject({ method: "GET", url: "/kernel/status", headers: auth() });
    expect(st.statusCode).toBe(200);
    expect(st.json().pools).toBeInstanceOf(Array);
  });

  it("非法 lang → 400", async () => {
    const r = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "ruby" }, headers: auth() });
    expect(r.statusCode).toBe(400);
  });
});
