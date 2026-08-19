# v1.3 PTL Operator Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a loopback-only PTL Web operator console with Overview, Work, Debug, Memory and Config pages while keeping N30 read-only and mapping every write to an allowlisted native PTH action.

**Architecture:** PTL owns the browser shell, short-lived operator session, command preview/confirmation and channel audit. N30 remains a separate read-only process and is same-origin proxied into Overview; PTH remains the authoritative owner of Task, Intake, Optimizer, Memory, Role and Config state. Operator commands are ephemeral before submission and immediately collapse to a native PTH reference afterward—no unified Workflow engine is added.

**Tech Stack:** Node.js 22 HTTP server, TypeScript 5.7, vanilla HTML/CSS/ES modules, existing PTL `PthClient`, N30 HTTP/SSE, Fastify 5, PostgreSQL, Vitest/Testcontainers; no runtime frontend dependency.

**Spec:** `docs/pth/n33-v13-ptl-operator-console-design.md`

## Global Constraints

- Target v1.3.0; N31 unified Workflow construction stays deferred to 2.0.
- Sidebar page IDs are exactly `overview`, `work`, `debug`, `memory`, `config`.
- Default bind is exactly `127.0.0.1`; v1.3 has no non-loopback override.
- Browser receives neither Docker Socket access nor PTH/N30 service tokens, database URLs, environment secrets or professional software credentials.
- N30 process remains GET/SSE-only and never gains PTH write credentials.
- Only the Work page can initiate writes; all other pages are read-only.
- Work writes require a server-generated, expiring, single-use preview digest plus idempotency key.
- Registered mode/action adapters are the only control surface; arbitrary HTTP path, URL, SQL and shell are forbidden.
- Intake actions may reference only an already verified human-signed Trust Policy; the console does not create or store human private keys.
- Debug never exposes chain-of-thought, complete prompts, secrets, arbitrary files or unscoped memory content.
- Memory queries are tenant/space/status/time/cursor bounded in SQL; no retrieve-all-then-filter path is accepted.
- Config is read-only in v1.3; all secrets use constant `***` redaction.
- N30 and PTH failures degrade independently; neither observability nor console failure may block PTH execution.
- Runtime assets remain vanilla HTML/CSS/JavaScript; a dev-only browser tool may be used for acceptance but no frontend framework is added.
- Each task follows TDD and ends in an independently reviewable commit.

---

### Task 1: Operator Console Contracts and Native-Action Registry

**Files:**
- Create: `packages/framework/src/operator-console/contracts.ts`
- Create: `packages/framework/src/operator-console/action-registry.ts`
- Create: `test/unit/operator-console-contracts.test.ts`
- Create: `test/unit/operator-console-action-registry.test.ts`

**Interfaces:**
- Consumes: canonical JSON protocol `WorkMode` from `@away_from/shared` after v1.3 M0 merges; PTL does not import PTH source/contracts.
- Produces: `OperatorPageId`, `OperatorCommandPreview`, `NativeWorkRef`, `OperatorModeAdapter<T>`, `OperatorActionRegistry`, validators and canonical preview digest.

- [ ] **Step 1: Write failing contract and registry tests**

```ts
const registry = createOperatorActionRegistry();
registry.register(fakeAdapter("run", "task.publish"));

expect(registry.get("run", "task.publish")).toBeDefined();
expect(() => registry.register(fakeAdapter("run", "task.publish"))).toThrow(/duplicate/i);
expect(() => registry.get("run", "http.request")).toThrow(/unknown/i);
expect(OPERATOR_PAGE_IDS).toEqual(["overview", "work", "debug", "memory", "config"]);
```

- [ ] **Step 2: Run the tests and confirm exports are absent**

Run: `npx vitest run test/unit/operator-console-contracts.test.ts test/unit/operator-console-action-registry.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement frozen contracts and canonical digest**

```ts
export interface OperatorModeAdapter<TInput = unknown> {
  readonly mode: WorkMode;
  readonly action: string;
  describe(): OperatorFormDescriptor;
  preview(input: TInput, context: OperatorContext): Promise<OperatorCommandPreview>;
  submit(preview: OperatorCommandPreview, context: OperatorContext): Promise<NativeWorkRef>;
  inspect(ref: NativeWorkRef, context: OperatorContext): Promise<NativeWorkProjection>;
  evaluate(ref: NativeWorkRef, context: OperatorContext): Promise<OperatorAcceptanceProjection>;
}
```

Canonical preview bytes include mode, action, normalized input, native target, impact, tenant, space and expiry. They exclude display labels and CSRF/session tokens. Use SHA-256 and reject non-finite numbers, prototypes, functions and unknown top-level fields.

- [ ] **Step 4: Add mutation, unknown-field and immutability tests**

Assert key-order stability, one-byte input mutation changes digest, cross-tenant context changes digest, deep objects are copied/frozen, and `action="shell.exec"` cannot be registered without an exact compile-time adapter object.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run test/unit/operator-console-contracts.test.ts test/unit/operator-console-action-registry.test.ts`

Expected: PASS.

```bash
git add packages/framework/src/operator-console/contracts.ts packages/framework/src/operator-console/action-registry.ts test/unit/operator-console-contracts.test.ts test/unit/operator-console-action-registry.test.ts
git commit -m "feat(ptl): add operator console action contracts"
```

---

### Task 2: Loopback Server, One-Time Bootstrap, CSRF, and Asset Packaging

**Files:**
- Create: `packages/framework/src/operator-console/session.ts`
- Create: `packages/framework/src/operator-console/server.ts`
- Create: `packages/framework/src/operator-console/launch.ts`
- Create: `packages/framework/src/operator-console/index.ts`
- Create: `packages/framework/web/operator-console/index.html`
- Create: `packages/framework/web/operator-console/styles.css`
- Create: `packages/framework/web/operator-console/app.js`
- Create: `scripts/copy-framework-web-assets.mjs`
- Modify: `packages/framework/src/cli/args.ts`
- Modify: `packages/framework/src/cli/run.ts`
- Modify: `packages/framework/src/cli/main.ts`
- Modify: `package.json`
- Create: `test/unit/operator-console-session.test.ts`
- Create: `test/unit/operator-console-server.test.ts`
- Modify: `test/unit/parse-args.test.ts`
- Modify: `test/unit/pit-route.test.ts`
- Modify: `test/unit/pit-help.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts and PTL configuration for server-held PTH/N30 endpoints.
- Produces: `createOperatorConsoleServer(deps)`, `startOperatorConsole(opts)`, `ptl operator`, same-origin `/api/session/bootstrap`, CSRF-protected API shell and five-page static assets.

- [ ] **Step 1: Write one-time bootstrap and request-boundary tests**

```ts
const app = createOperatorConsoleServer({
  host: "127.0.0.1",
  bootstrapToken: "a".repeat(64),
  operatorPrincipalId: "human-local-alice",
  clock,
  pth: fakePth,
  n30: fakeN30,
});

const first = await request(app, "POST", "/api/session/bootstrap", {
  origin: app.origin,
  host: app.hostHeader,
  json: { token: "a".repeat(64) },
});
expect(first.status).toBe(200);
expect(first.headers["set-cookie"]).toMatch(/HttpOnly.*SameSite=Strict/);
expect((await replayBootstrap(app)).status).toBe(401);
```

Cover foreign Origin, forged Host, missing cookie, missing/wrong CSRF, idle expiry, cookie replay after restart, path traversal, unsupported method and non-loopback bind.

- [ ] **Step 2: Run tests and confirm server/session are absent**

Run: `npx vitest run test/unit/operator-console-session.test.ts test/unit/operator-console-server.test.ts test/unit/parse-args.test.ts test/unit/pit-route.test.ts test/unit/pit-help.test.ts`

Expected: FAIL on missing modules/command.

- [ ] **Step 3: Implement in-memory Operator Session**

Use `randomBytes(32)`, `timingSafeEqual`, SHA-256 stored token digests, 30-minute idle expiry and `__Host-ptl-operator` cookie. Because `__Host-` requires HTTPS in browsers, use `ptl-operator` on loopback HTTP and switch to `__Host-ptl-operator` only in a future TLS profile; tests must reject accidentally claiming Secure on plain HTTP.

Every POST calls one guard that checks method, exact Origin, Host, cookie, expiry and `X-PTL-CSRF`. GET APIs require the cookie but not CSRF. Do not enable CORS.

- [ ] **Step 4: Implement an import-safe server factory**

```ts
export function createOperatorConsoleServer(deps: OperatorConsoleServerDeps): {
  readonly server: Server;
  readonly origin: string;
  listen(): Promise<{ port: number; bootstrapUrl: string }>;
  close(): Promise<void>;
} { /* route table is explicit; no catch-all proxy */ }
```

The server serves only known asset filenames with fixed MIME types. Unknown `/api/*` returns JSON 404; unknown page paths redirect to `/#/overview` only after authentication.

- [ ] **Step 5: Add the five-page shell and safe renderer**

`index.html` contains the fixed nav and empty page roots. `app.js` reads the bootstrap fragment, exchanges it, clears the URL and uses `textContent`/DOM creation only. No memory, error or config value may flow through `innerHTML`.

- [ ] **Step 6: Add deterministic asset copying**

`scripts/copy-framework-web-assets.mjs` recursively copies exactly `index.html`, `styles.css`, `app.js` into `packages/framework/dist/operator-console/public`, rejects symlinks and unknown extensions, and removes only that destination before copying. Update root `build` to run it immediately after `tsc -p packages/framework`.

The server resolves `./public` beside compiled output, falling back to `../../web/operator-console` only for source-mode `tsx` development.

- [ ] **Step 7: Wire `ptl operator`**

Add `operator` as a top-level command, valued flags `port` and `host`, and boolean `no-open`. Reject any host other than `127.0.0.1`. Open the generated loopback URL with argv-based platform commands; the URL is generated locally and contains only a hex fragment token. Always print the URL for manual fallback.

- [ ] **Step 8: Build, run tests, and commit**

Run: `npx vitest run test/unit/operator-console-session.test.ts test/unit/operator-console-server.test.ts test/unit/parse-args.test.ts test/unit/pit-route.test.ts test/unit/pit-help.test.ts`

Run: `npm run build`

Expected: PASS; `packages/framework/dist/operator-console/public` contains exactly three assets.

```bash
git add packages/framework/src/operator-console packages/framework/web/operator-console scripts/copy-framework-web-assets.mjs packages/framework/src/cli/args.ts packages/framework/src/cli/run.ts packages/framework/src/cli/main.ts package.json test/unit/operator-console-session.test.ts test/unit/operator-console-server.test.ts test/unit/parse-args.test.ts test/unit/pit-route.test.ts test/unit/pit-help.test.ts
git commit -m "feat(ptl): add secure local operator console shell"
```

---

### Task 3: Bounded PTH Inspection Projections

**Files:**
- Create: `src/pth/contracts/system-inspection.ts`
- Modify: `src/pth/contracts/index.ts`
- Create: `src/pth/application/observation/system-inspection-facade.ts`
- Modify: `src/pth/config/config-center.ts`
- Modify: `src/pth/gateway/routes-observe.ts`
- Modify: `src/pth/gateway/server.ts`
- Modify: `src/pth/main.ts`
- Create: `test/pth-contracts/system-inspection.test.ts`
- Create: `test/pth-application/system-inspection-facade.pg.test.ts`
- Modify: `test/pth-kernel-execution/config-center.test.ts`
- Create: `test/pth-gateway/system-inspection-routes.test.ts`

**Interfaces:**
- Consumes: tenant-scoped PG memory tables, BatchManager/Worker Replica snapshots, `PTH_CONFIG_SCHEMA`, redacted ConfigCenter snapshot and Runtime Catalog.
- Produces: read-only `/api/v1/observe/workers`, `/memory/*`, `/config`, `/roles` DTOs with cursor/time/limit enforcement.

- [ ] **Step 1: Write DTO redaction and pagination tests**

```ts
expect(configEntry({ key: "DATABASE_URL", secret: true, effective: "postgres://secret" }))
  .toMatchObject({ effectiveValue: "***", defaultValue: "***", secret: true });

const page = await facade.queryMemory(scopeA, { limit: 20 });
expect(page.items).toHaveLength(20);
expect(page.items.every((x) => x.tenantId === undefined)).toBe(true);
expect(JSON.stringify(page)).not.toContain("tenant-b-secret");
```

- [ ] **Step 2: Run tests and confirm contracts/facade are absent**

Run: `npx vitest run test/pth-contracts/system-inspection.test.ts test/pth-application/system-inspection-facade.pg.test.ts test/pth-kernel-execution/config-center.test.ts test/pth-gateway/system-inspection-routes.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 3: Implement DTOs and SQL-first memory projection**

Define `WorkerInspection`, `MemorySummary`, `MemoryListItem`, `MemoryRevisionEvent`, `ConfigInspectionEntry` and `RoleInspection`. Memory list SQL includes tenant, visible status/space, optional type/kind/anchor, `updated_at` cursor and limit. Summary computes both `count(*)` and `octet_length(content)` by canonical MemoryType. Recent revisions query the append-only revision log plus current revision events and returns exactly ten at the route boundary.

- [ ] **Step 4: Implement Worker, Config and Role projections**

Worker output contains IDs, role revision, lifecycle, work mode, current task/lease IDs, region IDs/weights, Working Set IDs/counts/usage/omitted, action tool names, Skill IDs and heartbeat. It excludes prompt/content/secret/environment.

Add `ConfigCenter.explain(key)` and track initial `default|env` plus later `runtime` writes without retaining secret history. Config output joins schema definition with the redacted explanation and a source enum (`default`, `env`, `runtime`, `file`, `unknown`); `file` is used only by a configuration adapter that can prove it. Never infer source from equality to default. Role output comes from Runtime Catalog and uses `roleDefinitionRevision()`.

- [ ] **Step 5: Register read-only routes**

All routes derive scope from `req.auth`, reject tenant/space query overrides, default limit 20/max 100, and return 400 for malformed cursors. `GET /memory/entries/:id` uses exact ID plus tenant/visibility predicates rather than retrieving all entries.

- [ ] **Step 6: Add cross-tenant, private-space, archived, secret and unbounded-query negatives**

Use real PostgreSQL rows for two tenants and sibling spaces. Assert no route issues SQL without a tenant predicate, no missing filter falls back to `retrieveMemory({})`, recent ten are revision events in descending time order, and zero-memory summary has count/bytes zero for all five types.

- [ ] **Step 7: Run and commit**

Run: `npx vitest run test/pth-contracts/system-inspection.test.ts test/pth-application/system-inspection-facade.pg.test.ts test/pth-kernel-execution/config-center.test.ts test/pth-gateway/system-inspection-routes.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add src/pth/contracts/system-inspection.ts src/pth/contracts/index.ts src/pth/application/observation/system-inspection-facade.ts src/pth/config/config-center.ts src/pth/gateway/routes-observe.ts src/pth/gateway/server.ts src/pth/main.ts test/pth-contracts/system-inspection.test.ts test/pth-application/system-inspection-facade.pg.test.ts test/pth-kernel-execution/config-center.test.ts test/pth-gateway/system-inspection-routes.test.ts
git commit -m "feat(observe): add bounded system inspection projections"
```

---

### Task 4: Overview via Read-Only N30 Same-Origin Proxy

**Files:**
- Create: `packages/framework/src/operator-console/n30-proxy.ts`
- Modify: `packages/framework/src/operator-console/server.ts`
- Modify: `packages/framework/web/operator-console/app.js`
- Modify: `packages/framework/web/operator-console/styles.css`
- Modify: `deploy/docker-monitor/index.html`
- Modify: `deploy/docker-monitor/server.js`
- Modify: `test/unit/docker-monitor-server.test.ts`
- Create: `test/unit/operator-console-n30-proxy.test.ts`

**Interfaces:**
- Consumes: N30 `GET /`, `/snapshot`, `/events` from its read-only loopback endpoint.
- Produces: same-origin `/observe/`, `/observe/snapshot`, `/observe/events` and the Overview page with an `embed=1` N30 view.

- [ ] **Step 1: Write method/path/header/redirect boundary tests**

Assert only the three exact GET routes proxy; POST, Upgrade, path suffixes, query-supplied target URLs and upstream redirects reject. Strip authorization, cookie, set-cookie, connection and proxy headers in both directions.

- [ ] **Step 2: Run tests and confirm proxy/embed mode are absent**

Run: `npx vitest run test/unit/operator-console-n30-proxy.test.ts test/unit/docker-monitor-server.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the read-only proxy**

Use one configured loopback `N30_URL`; do not accept upstream from the browser. Apply response size/time limits to HTML and snapshot. SSE streams have bounded client count, heartbeat timeout and abort on browser close.

- [ ] **Step 4: Add N30 embed mode**

`GET /?embed=1&base=/observe` hides the standalone header, prefixes snapshot/events with the validated base and preserves the same N30 UI/state modules. Base must start with `/` and contain no scheme, host, `..` or encoded slash.

- [ ] **Step 5: Render Overview and degradation states**

The Overview page contains the embedded N30 panel plus source freshness. N30 disconnected shows an explicit banner and retry control; navigation to Work/Debug/Memory/Config remains usable.

- [ ] **Step 6: Run and commit**

Run: `npx vitest run test/unit/operator-console-n30-proxy.test.ts test/unit/docker-monitor-server.test.ts test/unit/operator-console-server.test.ts`

Expected: PASS.

```bash
git add packages/framework/src/operator-console/n30-proxy.ts packages/framework/src/operator-console/server.ts packages/framework/web/operator-console/app.js packages/framework/web/operator-console/styles.css deploy/docker-monitor/index.html deploy/docker-monitor/server.js test/unit/docker-monitor-server.test.ts test/unit/operator-console-n30-proxy.test.ts
git commit -m "feat(ptl): embed the read-only n30 overview"
```

---

### Task 5: Work Page Preview, Confirmation, and Three Native Adapters

**Files:**
- Create: `packages/framework/src/operator-console/preview-store.ts`
- Create: `packages/framework/src/operator-console/channel-audit.ts`
- Create: `packages/framework/src/operator-console/actions/run-actions.ts`
- Create: `packages/framework/src/operator-console/actions/intake-actions.ts`
- Create: `packages/framework/src/operator-console/actions/optimize-actions.ts`
- Create: `packages/framework/src/operator-console/pth-operator-client.ts`
- Modify: `packages/framework/src/operator-console/server.ts`
- Modify: `packages/framework/web/operator-console/app.js`
- Modify: `packages/framework/web/operator-console/styles.css`
- Create: `src/pth/gateway/routes-intake.ts`
- Create: `src/pth/execution/knowledge-intake/manual-control.ts`
- Modify: `src/pth/application/gateway/pth-gateway-facade.ts`
- Modify: `src/pth/gateway/routes-kernel.ts`
- Modify: `src/pth/gateway/server.ts`
- Modify: `src/pth/main.ts`
- Modify: `packages/framework/src/bridge/client.ts`
- Create: `test/unit/operator-console-preview-store.test.ts`
- Create: `test/unit/operator-console-work-actions.test.ts`
- Create: `test/pth-gateway/intake-routes.test.ts`
- Modify: `test/pth-gateway/kernel-routes.test.ts`
- Create: `test/pth-composition/operator-console-work.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 registry, Operator Session, M0 WorkEnvelope, existing task publish, `createKnowledgeIntakeSubscriptionService`, N29 run service and optimizer suggestion/apply APIs.
- Produces: `/api/work/actions`, `/preview`, `/submit`, `/native/:kind/:id`, `/evaluate` and run/intake/optimize forms.

- [ ] **Step 1: Write preview expiry, mutation, replay and idempotency tests**

```ts
const preview = await service.preview("run", "task.publish", input, ctx);
expect(await service.submit({ previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k1" }, ctx))
  .toMatchObject({ kind: "task", mode: "run" });
await expect(service.submit({ previewId: preview.previewId, previewDigest: preview.previewDigest, idempotencyKey: "k2" }, ctx))
  .rejects.toThrow(/consumed/i);
```

Also test same idempotency key returns the same native ref after an ambiguous network timeout, while same key with a different digest conflicts.

- [ ] **Step 2: Run tests and confirm Work services/routes are absent**

Run: `npx vitest run test/unit/operator-console-preview-store.test.ts test/unit/operator-console-work-actions.test.ts test/pth-gateway/intake-routes.test.ts test/pth-composition/operator-console-work.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement an in-memory preview store and append-only channel audit**

Preview TTL is 15 minutes and maximum pending previews is 100. Consumption and idempotency update happen under one process-local mutex before the native call; ambiguous results remain `submitting` and are reconciled by idempotency lookup. Audit uses append-only JSONL opened with mode `0600` and `O_APPEND`; each encoded record is one bounded write followed by `fsync`. A final crash-truncated line is ignored on read. Fields are fixed and contain normalized error codes, not full input/content/secret.

- [ ] **Step 4: Implement the first three adapters**

Register exactly:

```text
run/task.publish
intake/subscription.create
intake/run.trigger
optimize/suggestion.apply
```

`run/task.publish` emits a server-stamped WorkEnvelope mode `run`. `intake/subscription.create` calls the existing subscription service with the currently loaded verified policy and refuses a policy ID/version/digest mismatch. `intake/run.trigger` calls a new narrow `triggerSubscriptionRun(scope, subscriptionId, idempotencyKey)` service that transactionally creates/wakes one native run without accepting an arbitrary URL. `optimize/suggestion.apply` first makes the existing facade/route tenant-scoped, accepts only a visible draft suggestion ID and preserves its canary/deopt guards.

- [ ] **Step 5: Add narrow PTH intake routes**

Expose subscription create, run trigger and native status through a dedicated route file. Scope comes from auth; manifest/private key are never accepted in request body. The production service supplies the current verified policy and repository. Duplicate idempotency keys return the original subscription/run.

- [ ] **Step 6: Implement Work UI**

Render three tabs and server-provided field descriptors. Preview displays normalized summary, tenant/space, native target, reversibility, risk and expiry. Confirmation requires typing the action label for high risk and cannot be the initially focused button. After submit, poll/SSE native status and render mode-specific acceptance evidence; no universal workflow state is created.

- [ ] **Step 7: Add arbitrary path/shell/extra-field/trust expansion negatives**

Assert inputs containing `path`, `method`, `command`, `sql`, unregistered actions, a new source origin, policy replacement, hard-guard disable, mode mutation or cross-tenant native ref all reject before any backing call.

- [ ] **Step 8: Run and commit**

Run: `npx vitest run test/unit/operator-console-preview-store.test.ts test/unit/operator-console-work-actions.test.ts test/pth-gateway/intake-routes.test.ts test/pth-gateway/kernel-routes.test.ts test/pth-composition/operator-console-work.integration.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add packages/framework/src/operator-console/preview-store.ts packages/framework/src/operator-console/channel-audit.ts packages/framework/src/operator-console/actions packages/framework/src/operator-console/pth-operator-client.ts packages/framework/src/operator-console/server.ts packages/framework/web/operator-console/app.js packages/framework/web/operator-console/styles.css src/pth/gateway/routes-intake.ts src/pth/execution/knowledge-intake/manual-control.ts src/pth/application/gateway/pth-gateway-facade.ts src/pth/gateway/routes-kernel.ts src/pth/gateway/server.ts src/pth/main.ts packages/framework/src/bridge/client.ts test/unit/operator-console-preview-store.test.ts test/unit/operator-console-work-actions.test.ts test/pth-gateway/intake-routes.test.ts test/pth-gateway/kernel-routes.test.ts test/pth-composition/operator-console-work.integration.test.ts
git commit -m "feat(ptl): add native run intake optimize commands"
```

---

### Task 6: Read-Only Worker Debug Page

**Files:**
- Create: `packages/framework/web/operator-console/debug.js`
- Modify: `packages/framework/web/operator-console/app.js`
- Modify: `packages/framework/web/operator-console/index.html`
- Modify: `packages/framework/web/operator-console/styles.css`
- Modify: `packages/framework/src/operator-console/pth-operator-client.ts`
- Modify: `packages/framework/src/operator-console/server.ts`
- Create: `test/unit/operator-console-debug-view.test.ts`
- Create: `test/pth-composition/operator-console-worker-debug.integration.test.ts`

**Interfaces:**
- Consumes: Task 3 WorkerInspection and N30 batch resource snapshots.
- Produces: worker filters, worker detail, structured recent events and batch-associated resource chart.

- [ ] **Step 1: Write view-model and secret-absence tests**

Filter by workerId, roleId, WorkMode and lifecycle. Assert role revision remains distinct from worker ID, Working Set lists IDs/counts only, responsibility regions contain no body, and serialized response has no `prompt`, `chainOfThought`, `token`, `secret`, `env` or memory content.

- [ ] **Step 2: Run tests and confirm debug module is absent**

Run: `npx vitest run test/unit/operator-console-debug-view.test.ts test/pth-composition/operator-console-worker-debug.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement worker list/detail and freshness**

Poll the authoritative worker snapshot every two seconds; mark lagging after five seconds and stale after fifteen. Recent ActivityHub events are hints and never resurrect a missing worker. Display associated Batch resource series with label “关联 Batch 资源”, not “Worker 资源”.

- [ ] **Step 4: Keep the page read-only**

Do not render or accept pause/resume/remove/retry/cancel. Server route table has GET only for debug data. Add a regression that posting to every `/api/debug/*` path returns 404/405 and triggers zero BatchManager calls.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run test/unit/operator-console-debug-view.test.ts test/pth-composition/operator-console-worker-debug.integration.test.ts`

Expected: PASS.

```bash
git add packages/framework/web/operator-console/debug.js packages/framework/web/operator-console/app.js packages/framework/web/operator-console/index.html packages/framework/web/operator-console/styles.css packages/framework/src/operator-console/pth-operator-client.ts packages/framework/src/operator-console/server.ts test/unit/operator-console-debug-view.test.ts test/pth-composition/operator-console-worker-debug.integration.test.ts
git commit -m "feat(ptl): add read-only worker debug view"
```

---

### Task 7: Memory Browser, Dual Pie Charts, and Recent Ten Revisions

**Files:**
- Create: `packages/framework/web/operator-console/memory.js`
- Modify: `packages/framework/web/operator-console/app.js`
- Modify: `packages/framework/web/operator-console/index.html`
- Modify: `packages/framework/web/operator-console/styles.css`
- Modify: `packages/framework/src/operator-console/pth-operator-client.ts`
- Modify: `packages/framework/src/operator-console/server.ts`
- Create: `test/unit/operator-console-memory-view.test.ts`
- Create: `test/pth-composition/operator-console-memory.integration.test.ts`

**Interfaces:**
- Consumes: Task 3 memory summary/list/detail/revision APIs.
- Produces: count pie, UTF-8 byte pie, paginated query, lazy detail and recent ten revision table.

- [ ] **Step 1: Write pie denominator and empty-state tests**

```ts
const charts = buildMemoryCharts({
  setting: { count: 1, bytes: 10 },
  wiki: { count: 3, bytes: 90 },
  skill: { count: 0, bytes: 0 },
  log: { count: 0, bytes: 0 },
  index: { count: 6, bytes: 20 },
});
expect(charts.count.total).toBe(10);
expect(charts.bytes.total).toBe(120);
expect(charts.count.slices.find((x) => x.type === "index")?.ratio).toBe(0.6);
```

All-zero input yields `empty=true` and no artificial 100% slice.

- [ ] **Step 2: Run tests and confirm memory view is absent**

Run: `npx vitest run test/unit/operator-console-memory-view.test.ts test/pth-composition/operator-console-memory.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement accessible pie charts and table query**

Use SVG paths plus a text/table equivalent. Filters are type/kind/status/anchor and cursor; every search resets cursor. Render user content through text nodes. Do not fetch content for list rows.

- [ ] **Step 4: Implement lazy detail and recent revisions**

Clicking an exact entry ID loads bounded content/evidence/history. Recent table always requests `limit=10` and labels event action/revision/time/type; it is not derived from the current entry list. Unknown/deleted entry references show tombstone metadata without widening the query.

- [ ] **Step 5: Add no-write and no-full-scan tests**

Assert the console has no memory POST/PUT/DELETE route, list calls never invoke `retrieveMemory({})`, limit 101 rejects, cursor cannot cross tenant, and an HTML payload appears as text rather than markup.

- [ ] **Step 6: Run and commit**

Run: `npx vitest run test/unit/operator-console-memory-view.test.ts test/pth-composition/operator-console-memory.integration.test.ts`

Expected: PASS.

```bash
git add packages/framework/web/operator-console/memory.js packages/framework/web/operator-console/app.js packages/framework/web/operator-console/index.html packages/framework/web/operator-console/styles.css packages/framework/src/operator-console/pth-operator-client.ts packages/framework/src/operator-console/server.ts test/unit/operator-console-memory-view.test.ts test/pth-composition/operator-console-memory.integration.test.ts
git commit -m "feat(ptl): add bounded memory browser"
```

---

### Task 8: Read-Only Config and Role Catalog Page

**Files:**
- Create: `packages/framework/web/operator-console/config.js`
- Modify: `packages/framework/web/operator-console/app.js`
- Modify: `packages/framework/web/operator-console/index.html`
- Modify: `packages/framework/web/operator-console/styles.css`
- Modify: `packages/framework/src/operator-console/pth-operator-client.ts`
- Modify: `packages/framework/src/operator-console/server.ts`
- Create: `test/unit/operator-console-config-view.test.ts`
- Create: `test/pth-composition/operator-console-config.integration.test.ts`

**Interfaces:**
- Consumes: PTL `loadConfig()` redacted projection plus Task 3 PTH config and role DTOs.
- Produces: searchable config table, source/restart badges and Role Definition catalog.

- [ ] **Step 1: Write constant-redaction and role/worker distinction tests**

For every schema entry marked secret, test unset, short, long and malformed values all render exactly `***` for default/effective/source detail. Assert role rows have `roleRevision` and no worker lifecycle/heartbeat field.

- [ ] **Step 2: Run tests and confirm config view is absent**

Run: `npx vitest run test/unit/operator-console-config-view.test.ts test/pth-composition/operator-console-config.integration.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement PTL/PTH config tabs**

PTL tab shows redacted local template/model/path/connection facts. PTH tab shows key/group/type/default/effective/source/scope/runtime mutable/restart/description. Source `unknown` remains explicit. Neither tab has form inputs or save buttons.

- [ ] **Step 4: Implement Role catalog and lineage filters**

Show id, parent, revision, family, tags, capabilities, action tools, thinking, acceptance role, default replicas and budget/load policy references. Add filters without rewriting lineage. Default-zero professional roles remain visible.

- [ ] **Step 5: Add route and HTML leak scans**

Serialize the complete page/API responses and assert no configured secret value appears. POST/PUT/PATCH/DELETE under `/api/config` and `/api/roles` must reject with zero ConfigCenter/RuntimeCatalog mutation calls.

- [ ] **Step 6: Run and commit**

Run: `npx vitest run test/unit/operator-console-config-view.test.ts test/pth-composition/operator-console-config.integration.test.ts`

Expected: PASS.

```bash
git add packages/framework/web/operator-console/config.js packages/framework/web/operator-console/app.js packages/framework/web/operator-console/index.html packages/framework/web/operator-console/styles.css packages/framework/src/operator-console/pth-operator-client.ts packages/framework/src/operator-console/server.ts test/unit/operator-console-config-view.test.ts test/pth-composition/operator-console-config.integration.test.ts
git commit -m "feat(ptl): add read-only config and role catalog"
```

---

### Task 9: Browser, Security, Freshness, and v1.3 Authority Gate

**Files:**
- Create: `scripts/eval-n33-operator-console.ts`
- Create: `scripts/accept-n33-operator-console.ts`
- Create: `test/pth-composition/operator-console-browser.test.ts`
- Create: `test/pth-composition/operator-console-security.test.ts`
- Create: `test/pth-composition/operator-console-freshness.test.ts`
- Create: `docs/pth/n33-operator-console-report.md`
- Create: `docs/pth/n33-operator-console-envelope.json`
- Modify: `TODO.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: Tasks 1–8, N30 O0–O4, M0 WorkMode, N29 intake and v1.3 professional job slices.
- Produces: exact-denominator N33 metrics, security sabotage coverage, real-browser evidence and a commit-bound acceptance envelope.

- [ ] **Step 1: Freeze exact positive denominators**

The evaluator requires exactly:

```text
5 page routes
5 keyboard navigation paths
3 WorkMode native action round trips
3 WorkMode acceptance projections
15 freshness transitions (5 pages × fresh/lagging/stale)
5 memory type count/bytes slices
10 recent revision rows
all schema secrets redacted
all Runtime Catalog roles represented
```

Zero denominators, missing fields, NaN/Infinity or a page marked “not executed” are NO-GO.

- [ ] **Step 2: Add security sabotage cases**

Sabotage one boundary at a time: reused bootstrap, forged Host, foreign Origin, missing CSRF, stale preview, changed digest, repeated idempotency key with changed input, unknown adapter, arbitrary HTTP path, shell field, cross-tenant native ref, unverified intake source, browser token leak, raw Docker path leak, memory full scan, config secret leak, debug prompt leak and N30 POST proxy. Each sabotage must flip exactly its mapped gate.

- [ ] **Step 3: Add real browser/accessibility evidence**

Start PTL console, N30 and a test PTH on loopback. Use the repository-approved browser harness if present; otherwise the acceptance driver marks browser gate `EVALUATION-INCOMPLETE` and cannot emit GO. Verify page navigation, fragment bootstrap removal, keyboard focus, reduced motion, chart text alternatives, reconnect and XSS payload rendering.

- [ ] **Step 4: Add failure isolation and freshness tests**

Stop N30 and prove only Overview degrades. Stop PTH and prove every write rejects while the shell/N30 remain. Drop SSE frames and prove authoritative polls reconcile. Advance fake clocks through fresh→lagging→stale and assert running bars freeze rather than extend.

- [ ] **Step 5: Implement deterministic evaluator and acceptance driver**

Evaluator output is stable JSON with per-gate evidence and exact counts. Run twice on the same commit and require byte identity. The acceptance driver records evaluated commit, clean tree, asset manifest, focused/full/lint/build, N30 envelope, N29 non-regression, browser/security/freshness results and skip manifest.

Any unavailable required service is `EVALUATION-INCOMPLETE`; any started nonzero command or security violation is NO-GO and cannot be masked by an unavailable later gate.

- [ ] **Step 6: Run focused and authority gates**

Run: `node --import tsx scripts/eval-n33-operator-console.ts`

Run again and compare byte-for-byte.

Run: `npx vitest run test/unit/operator-console-*.test.ts test/pth-contracts/system-inspection.test.ts test/pth-application/system-inspection-facade.pg.test.ts test/pth-gateway/system-inspection-routes.test.ts test/pth-gateway/intake-routes.test.ts test/pth-composition/operator-console-*.test.ts --reporter=json --outputFile /tmp/n33-focused.json`

Run: `npm test -- --reporter=json --outputFile /tmp/n33-full.json`

Run: `npm run lint`

Run: `npm run build`

Run: `node --import tsx scripts/accept-n33-operator-console.ts`

Expected: GO only if N30, all five pages, three native modes, read-only boundaries, browser accessibility, freshness, security, full regression and build gates pass with no new skips.

- [ ] **Step 7: Commit evaluator, then generate and commit evidence**

```bash
git add scripts/eval-n33-operator-console.ts scripts/accept-n33-operator-console.ts test/pth-composition/operator-console-browser.test.ts test/pth-composition/operator-console-security.test.ts test/pth-composition/operator-console-freshness.test.ts
git commit -m "test(n33): add operator console authority gate"
```

Generate report/envelope on that implementation commit, then:

```bash
git add docs/pth/n33-operator-console-report.md docs/pth/n33-operator-console-envelope.json TODO.md docs/README.md
git commit -m "docs(n33): publish operator console acceptance"
```

## Execution Order

Execute strictly: **Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Tasks 6/7/8 → Task 9**.

Dependencies outside this plan:

- Task 1/5 require v1.3 M0 canonical WorkMode/WorkEnvelope;
- Task 3/7 require v1.3 P0 canonical five-type Memory projection, including `index`;
- Task 3/6 require the accepted N28 Worker Replica/Directory/Working Set observation model;
- Task 4 requires N30 O0–O3 and Task 9 requires N30 O4 authority evidence;
- Task 5 intake requires N29 to remain accepted on the evaluated commit;
- Task 5/9 professional run acceptance consumes N32 professional job evidence when available;
- Tasks 6/7/8 can proceed after Task 3 while Task 5 is under review.

Do not begin Task 9 on a mixed or dirty implementation tree. Do not label the console accepted from unit tests alone.
