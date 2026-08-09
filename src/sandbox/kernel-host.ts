/**
 * kernel-host.ts — sandbox 侧 kernel 宿主服务（kernel sandbox SPEC §3.2）
 *
 * 职责：托管 PyKernel/BashKernel 共享池，通过 HTTP 协议向 PTH 侧提供持久 REPL。
 *
 * 接口：
 *   POST /kernel/acquire  { lang: "python"|"bash" } → { kernelId }
 *   POST /kernel/execute  { kernelId, code, timeoutMs? } → InterpreterResult
 *   POST /kernel/reset    { kernelId } → { ok: true }（ns 清命名空间）
 *   POST /kernel/snapshot { kernelId } → InterpreterSnapshot（refine 价值抽取）
 *   POST /kernel/release  { kernelId } → { ok: true }
 *   GET  /kernel/status             → { pools: [{ lang, inFlight, idle, size, capacity }] }
 *   GET  /health                    → { status: "ok" }（无认证——内网可达，compose healthcheck）
 *
 * 安全边界（敏感信息 SPEC §4.5）：
 *   - 共享密钥认证（SANDBOX_SHARED_SECRET，与 exec API 同源）——fail-closed
 *   - execute 请求体【拒绝 env 字段】（400）——sandbox 侧零业务密钥
 *   - 池内 kernel 无出网（compose internal 网络）+ 无业务密钥 env
 */

import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { KernelPool, type KernelLang } from "./kernel-pool.js";
import { CCompiledKernel } from "../pth/kernel/interpreter/compiled-kernel.js";

export interface KernelHostOptions {
  /** 各语言池容量（默认 4） */
  poolSize?: number;
  /** 共享密钥获取器（默认读 env SANDBOX_SHARED_SECRET——每次请求读取，测试可注入） */
  getSecret?: () => string | undefined;
  onStderr?: (lang: string, line: string) => void;
}

const VALID_LANGS: KernelLang[] = ["python", "bash"];

/** 插件式注册：把 kernel 宿主路由挂到已有 Fastify app（sandbox main 与 exec API 同端口） */
export function registerKernelHost(app: FastifyInstance, opts: KernelHostOptions = {}): void {
  const getSecret = opts.getSecret ?? (() => process.env.SANDBOX_SHARED_SECRET);
  // 池容量：env PTH_KERNEL_POOL_SIZE 优先（compose 注入——需 >= 并发 worker 数），option 次之
  const envSize = Number(process.env.PTH_KERNEL_POOL_SIZE);
  const poolSize = opts.poolSize ?? (Number.isFinite(envSize) && envSize > 0 ? envSize : 4);

  const pools: Record<KernelLang, KernelPool> = {
    python: new KernelPool({ lang: "python", max: poolSize, onStderr: opts.onStderr }),
    bash: new KernelPool({ lang: "bash", max: poolSize, onStderr: opts.onStderr }),
  };

  type AuthResult = "ok" | "unauthorized" | "misconfigured";
  function checkAuth(req: FastifyRequest): AuthResult {
    const secret = getSecret();
    if (!secret) return "misconfigured";
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
    return token === secret ? "ok" : "unauthorized";
  }
  function enforceAuth(req: FastifyRequest, reply: any): boolean {
    const auth = checkAuth(req);
    if (auth === "ok") return true;
    reply.code(auth === "misconfigured" ? 503 : 401).send({ error: auth === "misconfigured" ? "server misconfigured: SANDBOX_SHARED_SECRET not set" : "unauthorized" });
    return false;
  }

  // /health 由 exec API 注册（组合模式）——独立 app（buildKernelHostApp）时自备
  if (!app.hasRoute({ method: "GET", url: "/health" })) {
    app.get("/health", async () => ({ status: "ok" }));
  }

  app.post("/kernel/acquire", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const { lang } = (req.body ?? {}) as { lang?: string };
    if (!lang || !VALID_LANGS.includes(lang as KernelLang)) {
      reply.code(400).send({ error: `invalid lang: ${lang ?? "(missing)"}` });
      return;
    }
    const kernelId = await pools[lang as KernelLang].acquire();
    return { kernelId };
  });

  app.post("/kernel/execute", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const body = (req.body ?? {}) as { kernelId?: string; code?: string; timeoutMs?: number; env?: unknown };
    if (!body.kernelId || typeof body.code !== "string") {
      reply.code(400).send({ error: "kernelId and code required" });
      return;
    }
    if (body.env !== undefined) {
      // 敏感信息约束：execute 拒绝 env 注入（sandbox 零业务密钥）
      reply.code(400).send({ error: "env injection rejected" });
      return;
    }
    try {
      const result = await pools[poolLang(body.kernelId)].execute(body.kernelId, body.code, body.timeoutMs ? { timeoutMs: body.timeoutMs } : undefined);
      return result;
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/kernel/reset", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const { kernelId } = (req.body ?? {}) as { kernelId?: string };
    if (!kernelId) {
      reply.code(400).send({ error: "kernelId required" });
      return;
    }
    try {
      await pools[poolLang(kernelId)].reset(kernelId);
      return { ok: true };
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/kernel/snapshot", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const { kernelId } = (req.body ?? {}) as { kernelId?: string };
    if (!kernelId) {
      reply.code(400).send({ error: "kernelId required" });
      return;
    }
    try {
      return await pools[poolLang(kernelId)].snapshot(kernelId);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/kernel/release", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const { kernelId } = (req.body ?? {}) as { kernelId?: string };
    if (!kernelId) {
      reply.code(400).send({ error: "kernelId required" });
      return;
    }
    pools[poolLang(kernelId)].release(kernelId);
    return { ok: true };
  });

  // ── 编译核（2026-08-09 Phase B：C 编译-运行管道落 sandbox 侧）────────────
  // POST /kernel/compiled {code, cc?, opt?, timeoutMs?} → InterpreterResult
  //   cc: 编译器变体（gcc|clang|tcc——缺省 auto=cc）；opt: -O0/-O2/-g 组合（缺省 -O0）
  //   编译在沙箱内（工具链 gcc/gdb/strace/valgrind/tcc 已装）——零业务密钥、cwd 白名单
  //   每次调用独立临时工作区（编译-运行管道——非持久进程——天然隔离）
  app.post("/kernel/compiled", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const { code, cc, timeoutMs } = (req.body ?? {}) as { code?: string; cc?: string; timeoutMs?: number };
    if (typeof code !== "string" || code.length === 0) {
      reply.code(400).send({ error: "code required" });
      return;
    }
    // 编译器变体白名单（显式 > 默认 cc）——防任意命令注入面（编译器路径固定）
    const ccBin = cc === "gcc" ? "gcc" : cc === "clang" ? "clang" : cc === "tcc" ? "tcc" : undefined;
    const workDir = `/data/workspaces/.compiled-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const kernel = new CCompiledKernel({
        workDir,
        cc: ccBin,
        compileTimeoutMs: timeoutMs ?? 60_000,
      });
      const result = await kernel.execute(code);
      return result;
    } catch (e) {
      return { ok: false, error: { message: `compiled kernel error: ${(e as Error).message}` }, durationMs: 0 };
    } finally {
      // 工作区清理（编译产物/缓存——一次性管道不留残渣）
      import("node:fs/promises").then(({ rm }) => rm(workDir, { recursive: true, force: true })).catch(() => {});
    }
  });

  app.get("/kernel/status", async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    return { pools: [pools.python.status(), pools.bash.status()] };
  });
}

/** 独立 app（测试用）——与 main.ts 同构：exec 与 kernel 路由同端口 */
export function buildKernelHostApp(opts: KernelHostOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerKernelHost(app, opts);
  return app;
}

/** 从 kernelId 前缀推断池（py- → python；sh- → bash） */
function poolLang(kernelId: string): KernelLang {
  return kernelId.startsWith("py-") ? "python" : "bash";
}
