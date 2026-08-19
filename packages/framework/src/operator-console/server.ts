/**
 * operator-console/server.ts — loopback-only HTTP server（import-safe factory）
 *
 * 路由表显式，无 catch-all proxy。只服务三个已知静态资源文件名；
 * 未知 /api/* 一律 JSON 404；未知页面路径仅在认证后 302 到 /#/overview。
 * 不开启 CORS。浏览器侧拿不到 PTH/N30 token 或 Docker socket 路径。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createOperatorSessionManager,
  OPERATOR_COOKIE_NAME,
  OPERATOR_SESSION_IDLE_TIMEOUT_MS,
  OPERATOR_TOKEN_PATTERN,
  type OperatorSessionClock,
  type OperatorSessionManager,
} from "./session.js";

export interface OperatorConsolePthDeps {
  readonly baseUrl?: string;
  /** PTH admin token 只允许存在于服务端内存；任何响应/静态资源都不得包含它。 */
  readonly token?: string;
}

export interface OperatorConsoleN30Deps {
  readonly baseUrl?: string;
}

export interface OperatorConsoleServerDeps {
  /** 只允许 127.0.0.1；省略默认 127.0.0.1，显式其他值立即抛错（fail-closed）。 */
  readonly host?: string;
  /** 预生成的一次性 bootstrap token（64 位小写 hex）；省略则由 startOperatorConsole 生成。 */
  readonly bootstrapToken?: string;
  readonly operatorPrincipalId?: string;
  readonly clock?: OperatorSessionClock;
  readonly idleTimeoutMs?: number;
  readonly port?: number;
  /** 服务端持有的 PTH/N30 端点；本 Task 不暴露给浏览器，只作为 API 壳依赖。 */
  readonly pth: OperatorConsolePthDeps;
  readonly n30: OperatorConsoleN30Deps;
}

export interface OperatorConsoleServer {
  readonly server: Server;
  readonly origin: string;
  readonly hostHeader: string;
  readonly port: number;
  listen(): Promise<{ port: number; bootstrapUrl: string }>;
  close(): Promise<void>;
}

const BIND_HOST = "127.0.0.1";
const ASSET_MIME: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
};
const KNOWN_ASSETS = new Set(Object.keys(ASSET_MIME));
const MAX_JSON_BODY_BYTES = 16 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "cache-control": "no-store", ...extraHeaders });
  res.end();
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function resolveAssetDirectory(): string {
  // 编译产物：dist/operator-console/public；源码 tsx/vitest：web/operator-console
  const compiled = fileURLToPath(new URL("./public/", import.meta.url));
  const source = fileURLToPath(new URL("../../web/operator-console/", import.meta.url));
  return existsSync(path.join(compiled, "index.html")) ? compiled : source;
}

export function createOperatorConsoleServer(deps: OperatorConsoleServerDeps): OperatorConsoleServer {
  const host = deps.host ?? BIND_HOST;
  if (host !== BIND_HOST) {
    throw new Error(`operator console only binds to 127.0.0.1 (refusing host: ${host})`);
  }

  const bootstrapToken = deps.bootstrapToken ?? "";
  if (!OPERATOR_TOKEN_PATTERN.test(bootstrapToken)) {
    throw new Error("operator console bootstrap token must be 64 lowercase hex characters");
  }
  const operatorPrincipalId = deps.operatorPrincipalId ?? "human-local-operator";

  const sessions: OperatorSessionManager = createOperatorSessionManager({
    clock: deps.clock,
    idleTimeoutMs: deps.idleTimeoutMs ?? OPERATOR_SESSION_IDLE_TIMEOUT_MS,
  });
  sessions.issueBootstrapToken(operatorPrincipalId, bootstrapToken);

  const assetDir = resolveAssetDirectory();
  const assets = new Map<string, Buffer>();
  for (const filename of KNOWN_ASSETS) {
    const fullPath = path.join(assetDir, filename);
    if (!existsSync(fullPath)) {
      throw new Error(`operator console asset missing: ${fullPath}`);
    }
    assets.set(filename, readFileSync(fullPath));
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: { code: "INTERNAL", message } });
    });
  });

  let originValue: string | undefined;
  let hostHeaderValue: string | undefined;
  let portValue: number | undefined;

  const started = new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(deps.port ?? 0, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address === "object") {
        portValue = address.port;
        originValue = `http://${BIND_HOST}:${address.port}`;
        hostHeaderValue = `${BIND_HOST}:${address.port}`;
      }
      resolve();
    });
  });

  function requireBound(): number {
    if (portValue === undefined || originValue === undefined || hostHeaderValue === undefined) {
      throw new Error("operator console server is not listening yet; await listen() first");
    }
    return portValue;
  }

  function clearSessionCookie(res: ServerResponse): void {
    res.setHeader("set-cookie", `${OPERATOR_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  function sessionCookieHeader(res: ServerResponse, token: string, maxAgeSeconds: number): void {
    res.setHeader(
      "set-cookie",
      `${OPERATOR_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`,
    );
  }

  function hostMatches(req: IncomingMessage): boolean {
    const expected = hostHeaderValue;
    return expected !== undefined && req.headers.host === expected;
  }

  function originMatches(req: IncomingMessage): boolean {
    return originValue !== undefined && req.headers.origin === originValue;
  }

  /** 已认证 POST 的统一守卫：方法已由路由保证，检查 Origin、Host、cookie、过期与 CSRF。 */
  function guardAuthenticatedPost(req: IncomingMessage, res: ServerResponse): boolean {
    if (!originMatches(req) || !hostMatches(req)) {
      sendJson(res, 403, { error: { code: "FORBIDDEN_ORIGIN_HOST", message: "forged origin or host" } });
      return false;
    }
    const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
    if (!sessionToken || !sessions.authenticate(sessionToken)) {
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or expired session" } });
      return false;
    }
    const csrf = req.headers["x-ptl-csrf"];
    if (typeof csrf !== "string" || !sessions.verifyCsrf(sessionToken, csrf)) {
      sendJson(res, 401, { error: { code: "CSRF_MISMATCH", message: "missing or wrong X-PTL-CSRF" } });
      return false;
    }
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = req.url ?? "/";
    let pathname: string;
    try {
      pathname = new URL(requestUrl, `http://${BIND_HOST}`).pathname;
    } catch {
      sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "invalid request path" } });
      return;
    }
    const method = req.method ?? "GET";

    // ── 静态资源（只服务已知文件名，fixed MIME，同源无 CORS） ──
    if (pathname === "/") {
      if (method !== "GET" && method !== "HEAD") {
        sendEmpty(res, 405, { allow: "GET, HEAD" });
        return;
      }
      sendText(res, 200, assets.get("index.html")!.toString("utf8"), ASSET_MIME["index.html"]!);
      return;
    }
    const assetName = pathname.slice(1);
    if (KNOWN_ASSETS.has(assetName) && pathname === `/${assetName}`) {
      if (method !== "GET" && method !== "HEAD") {
        sendEmpty(res, 405, { allow: "GET, HEAD" });
        return;
      }
      sendText(res, 200, assets.get(assetName)!.toString("utf8"), ASSET_MIME[assetName]!);
      return;
    }

    // ── API（显式路由；未知 /api/* 一律 JSON 404） ──
    if (pathname === "/api/session/bootstrap") {
      if (method !== "POST") {
        sendEmpty(res, 405, { allow: "POST" });
        return;
      }
      if (!originMatches(req) || !hostMatches(req)) {
        sendJson(res, 403, { error: { code: "FORBIDDEN_ORIGIN_HOST", message: "forged origin or host" } });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) } });
        return;
      }
      if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).token !== "string") {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "body must be JSON with a token string" } });
        return;
      }
      const rawToken = (body as Record<string, unknown>).token as string;
      const bootstrapped = sessions.bootstrap(rawToken);
      if (!bootstrapped) {
        sendJson(res, 401, { error: { code: "BOOTSTRAP_REJECTED", message: "one-time bootstrap token rejected" } });
        return;
      }
      sessionCookieHeader(res, bootstrapped.sessionToken, Math.floor((deps.idleTimeoutMs ?? OPERATOR_SESSION_IDLE_TIMEOUT_MS) / 1000));
      sendJson(res, 200, {
        ok: true,
        csrfToken: bootstrapped.csrfToken,
        operatorPrincipalId: bootstrapped.principalId,
        expiresAt: bootstrapped.expiresAt,
      });
      return;
    }

    if (pathname === "/api/session") {
      if (method !== "GET" && method !== "HEAD") {
        sendEmpty(res, 405, { allow: "GET, HEAD" });
        return;
      }
      if (!hostMatches(req)) {
        sendJson(res, 403, { error: { code: "FORBIDDEN_HOST", message: "forged host" } });
        return;
      }
      const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
      if (!sessionToken) {
        sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing session cookie" } });
        return;
      }
      const session = sessions.authenticate(sessionToken);
      if (!session) {
        sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or expired session" } });
        return;
      }
      sendJson(res, 200, { ok: true, operatorPrincipalId: session.principalId, expiresAt: session.expiresAt });
      return;
    }

    if (pathname === "/api/session/logout") {
      if (method !== "POST") {
        sendEmpty(res, 405, { allow: "POST" });
        return;
      }
      const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
      if (!guardAuthenticatedPost(req, res)) return;
      sessions.destroy(sessionToken!);
      clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown api route" } });
      return;
    }

    // ── 未知页面路径：认证后 302 到 /#/overview；未认证 401 ──
    if (method !== "GET" && method !== "HEAD") {
      sendEmpty(res, 405, { allow: "GET, HEAD" });
      return;
    }
    const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
    if (!sessionToken || !sessions.authenticate(sessionToken)) {
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or expired session" } });
      return;
    }
    sendEmpty(res, 302, { location: "/#/overview" });
  }

  async function listen(): Promise<{ port: number; bootstrapUrl: string }> {
    await started;
    const port = requireBound();
    return { port, bootstrapUrl: `${originValue}/#${bootstrapToken}` };
  }

  async function close(): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return {
    server,
    get origin(): string {
      return originValue ?? `http://${BIND_HOST}:0`;
    },
    get hostHeader(): string {
      return hostHeaderValue ?? `${BIND_HOST}:0`;
    },
    get port(): number {
      return requireBound();
    },
    listen,
    close,
  };
}
