# N30 Runtime Observatory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the confirmed C-layout local runtime observatory with a shared Gantt/resource timeline and bounded freshness semantics for v1.3.0.

**Architecture:** Keep Docker sampling in `deploy/docker-monitor` and expose PTH execution intervals through a tenant-scoped read-only facade. The monitor server is the local aggregation adapter: it stores a bounded resource ring, reconciles durable PTH snapshots with SSE deltas, and sends one browser stream. The browser never receives Docker Socket access or PTH administration credentials.

**Tech Stack:** Node.js 22 HTTP/SSE, vanilla HTML/CSS/JavaScript, SVG/Canvas, Docker Engine Unix socket, Fastify 5, PostgreSQL, Redis ActivityHub as a non-authoritative delta source, Vitest/Testcontainers.

**Spec:** `docs/pth/n30-runtime-observatory-design.md`

## Global Constraints

- Implement N30 O0–O4 for v1.3.0; O5 tenant self-service and long-term history remain deferred.
- Timeline intervals expose server-stamped `WorkMode` (`intake`, `optimize`, `run`) as an orthogonal filter; it never replaces native status.
- Default listener is loopback only; non-loopback requires an explicit fail-closed config and authentication.
- Docker Socket, PTH admin token and professional software credentials never reach the browser.
- PTH tenant derives from authenticated server context, never request query/body.
- Durable Task/Job/Intake/Professional Job facts are authoritative; ActivityHub is only a low-latency hint.
- The server resource ring has a hard memory/sample limit and at most one hour default retention.
- Resource samples preserve missing values as `null`; missing data is never synthesized as zero.
- Healthy freshness targets are resource P95 ≤5s, activity P95 ≤2s and durable timeline P95 ≤10s.
- Any stale source freezes and marks its affected lanes/series; it does not silently continue as current.
- Browser rendering uses no new frontend framework or runtime dependency.
- The observatory is read-only and must remain unavailable without affecting PTH execution.
- N33 may embed the observatory only through a same-origin GET/SSE proxy; N30 never accepts control requests or PTH write credentials.
- Each task follows TDD and ends in an independently reviewable commit.

---

### Task 1: Runtime Observation DTO and Freshness Contract

**Files:**
- Create: `src/pth/contracts/runtime-observation.ts`
- Modify: `src/pth/contracts/index.ts`
- Create: `test/pth-contracts/runtime-observation.test.ts`

**Interfaces:**
- Consumes: canonical JSON protocol `WorkMode` from `@away_from/shared` plus tenant/task/job/intake/optimizer/professional-job/worker/role/trace identifiers.
- Produces: `RuntimeInterval`, `ResourceSample`, `RuntimeDelta`, `RuntimeSnapshot`, `FreshnessState`, WorkMode filters, validators and stable ID helpers.

- [ ] **Step 1: Write failing DTO invariant tests**

```ts
const interval: RuntimeInterval = {
  id: "task:tenant-a:t1:attempt:2",
  parentId: "job:tenant-a:j1",
  tenantId: "tenant-a",
  kind: "task",
  workMode: "run",
  label: "compile theorem",
  status: "running",
  startAt: 1000,
  endAt: null,
  sourceVersion: "2",
  freshness: {
    sourceObservedAt: 1200,
    collectedAt: 1250,
    expectedIntervalMs: 5000,
    staleAfterMs: 10000,
  },
  taskId: "t1",
  workerId: "w1",
  roleId: "lean4-prover",
  traceId: "tr1",
};
expect(validateRuntimeInterval(interval).ok).toBe(true);
expect(validateRuntimeInterval({ ...interval, endAt: 999 }).ok).toBe(false);
```

- [ ] **Step 2: Run test and confirm missing contract**

Run: `npx vitest run test/pth-contracts/runtime-observation.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 3: Implement pure DTOs and freshness calculation**

Freshness is computed from `sourceObservedAt`, `receivedAt` and source target latency. States are `fresh`, `lagging`, `stale`, `disconnected`; transitions are deterministic and clock-injected.

- [ ] **Step 4: Add malformed hierarchy, timestamp, revision and null-metric tests**

Reject cross-tenant parents, negative times, end before start, unknown WorkMode/status and non-finite metrics. Accept `null` CPU/RSS/Heap/Network values and running `endAt=null`. Assert changing status never changes WorkMode.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run test/pth-contracts/runtime-observation.test.ts`

Expected: PASS.

```bash
git add src/pth/contracts/runtime-observation.ts src/pth/contracts/index.ts test/pth-contracts/runtime-observation.test.ts
git commit -m "feat(observe): add runtime timeline contracts"
```

---

### Task 2: Bounded Docker Sample Collector and Local Service Timeline

**Files:**
- Create: `deploy/docker-monitor/ring-buffer.js`
- Modify: `deploy/docker-monitor/docker-api.js`
- Modify: `deploy/docker-monitor/metrics.js`
- Modify: `deploy/docker-monitor/server.js`
- Modify: `package.json`
- Modify: `test/unit/docker-monitor-metrics.test.ts`
- Create: `test/unit/docker-monitor-ring-buffer.test.ts`
- Create: `test/unit/docker-monitor-server.test.ts`

**Interfaces:**
- Consumes: Docker list/inspect/stats snapshots.
- Produces: bounded `ResourceSample[]`, container `RuntimeInterval[]`, `/snapshot`, and SSE `resource-sample`/`service-interval` events.

- [ ] **Step 1: Write ring capacity and out-of-order tests**

```ts
const ring = createTimeSeriesRing({ maxSamples: 1800, maxAgeMs: 3_600_000 });
for (let i = 0; i < 2000; i++) ring.push(sample(i * 2000));
expect(ring.size).toBe(1800);
expect(ring.range(0, Infinity)).toHaveLength(1800);
```

- [ ] **Step 2: Run tests and confirm ring/server APIs are absent**

Run: `npx vitest run test/unit/docker-monitor-ring-buffer.test.ts test/unit/docker-monitor-server.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement bounded ring and Docker inspect timestamps**

Inspect containers to obtain created/started/finished times. Container intervals use Docker ID plus start time as stable identity. Restart creates a new interval revision; disappeared containers retain intervals only within the ring window.

- [ ] **Step 4: Refactor server into import-safe factory**

```js
export function createMonitorServer({
  host = "127.0.0.1",
  port = 9090,
  intervalMs = 2000,
  maxSamples = 1800,
  docker = defaultDockerClient,
  clock = () => Date.now(),
} = {}) { /* returns {server, collectOnce, close, snapshot} */ }
```

Only an `import.meta.url` main guard starts timers/listening. `/snapshot` returns current intervals, samples and freshness; `/events` emits event IDs and heartbeats.

- [ ] **Step 5: Add Docker-unavailable and null-metric tests**

Assert the service still returns 200 with `sourceState=disconnected`, preserves null metrics and never emits an invented zero series. Assert host defaults to `127.0.0.1`.

- [ ] **Step 6: Fix the root monitor script and run tests**

Change `monitor` to `node deploy/docker-monitor/server.js`.

Run: `npx vitest run test/unit/docker-monitor-metrics.test.ts test/unit/docker-monitor-ring-buffer.test.ts test/unit/docker-monitor-server.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add deploy/docker-monitor/ring-buffer.js deploy/docker-monitor/docker-api.js deploy/docker-monitor/metrics.js deploy/docker-monitor/server.js package.json test/unit/docker-monitor-metrics.test.ts test/unit/docker-monitor-ring-buffer.test.ts test/unit/docker-monitor-server.test.ts
git commit -m "feat(observe): add bounded docker timeline collector"
```

---

### Task 3: Tenant-Scoped Durable PTH Timeline Projection

**Files:**
- Create: `src/pth/application/observation/runtime-observation-facade.ts`
- Modify: `src/pth/application/gateway/pth-gateway-facade.ts`
- Modify: `src/pth/gateway/routes-observe.ts`
- Modify: `src/pth/gateway/server.ts`
- Create: `test/pth-application/runtime-observation-facade.pg.test.ts`
- Create: `test/pth-gateway/observe-routes.test.ts`

**Interfaces:**
- Consumes: durable `tasks`, jobs, knowledge intake runs/attempts, worker/batch state and professional job traces.
- Produces: `RuntimeObservationFacade.queryTimeline(scope, window, cursor)` and `GET /api/v1/observe/timeline`.

- [ ] **Step 1: Write real PostgreSQL projection tests**

Seed completed, running, waiting, retry and failed Task/Intake cases for two tenants. Query tenant A and assert tenant B IDs are absent. Assert running intervals use `endAt=null`, attempts have distinct stable IDs and parent links resolve inside the result or are explicitly external.

- [ ] **Step 2: Run tests and confirm timeline facade is absent**

Run: `npx vitest run test/pth-application/runtime-observation-facade.pg.test.ts test/pth-gateway/observe-routes.test.ts`

Expected: FAIL on missing facade/route.

- [ ] **Step 3: Implement bounded SQL projection**

The facade accepts `from`, `to`, `limit<=5000`, optional modes/kinds/statuses and opaque cursor. SQL always includes tenant and overlap predicates, orders by start/revision/ID and reads no ActivityHub history. Task rows use durable `tasks.work_mode`; Intake rows are fixed `intake`; optimizer jobs/templates are fixed `optimize`.

- [ ] **Step 4: Add the route through the gateway facade**

`GET /api/v1/observe/timeline?from=&to=&modes=&limit=&cursor=` derives tenant/space from `req.auth`. Reject malformed windows, unknown modes, ranges above seven days, limit overflow and unauthorized roles. Add a `runtime-observer` read-only role check without granting any write route.

- [ ] **Step 5: Add cross-tenant, pagination and source-mutation tests**

Cover forged tenant query, cursor from another tenant, new rows between pages, and durable source changes. Projection must not write to any source table.

- [ ] **Step 6: Run and commit**

Run: `npx vitest run test/pth-application/runtime-observation-facade.pg.test.ts test/pth-gateway/observe-routes.test.ts test/pth-gateway/auth.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add src/pth/application/observation/runtime-observation-facade.ts src/pth/application/gateway/pth-gateway-facade.ts src/pth/gateway/routes-observe.ts src/pth/gateway/server.ts test/pth-application/runtime-observation-facade.pg.test.ts test/pth-gateway/observe-routes.test.ts
git commit -m "feat(observe): project durable pth timeline"
```

---

### Task 4: Server-Side PTH Aggregation, Reconcile, and Freshness

**Files:**
- Create: `deploy/docker-monitor/pth-client.js`
- Create: `deploy/docker-monitor/runtime-aggregator.js`
- Modify: `deploy/docker-monitor/server.js`
- Create: `test/unit/docker-monitor-pth-client.test.ts`
- Create: `test/unit/docker-monitor-runtime-aggregator.test.ts`
- Create: `test/pth-composition/runtime-observatory.integration.test.ts`

**Interfaces:**
- Consumes: Docker collector, PTH `/timeline` snapshot, low-latency PTH events.
- Produces: one monotonic browser `/events` stream with snapshot, upsert, remove, freshness and heartbeat events.

- [ ] **Step 1: Write lost-event and duplicate-event reconciliation tests**

Start from snapshot revision 1, apply duplicate/out-of-order deltas, omit a terminal delta, then reconcile against durable revision 2. Assert one final interval with revision 2 and no duplicate rows.

- [ ] **Step 2: Run tests and confirm aggregator is absent**

Run: `npx vitest run test/unit/docker-monitor-pth-client.test.ts test/unit/docker-monitor-runtime-aggregator.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement server-side credential boundary**

`pth-client.js` reads token/endpoint only on the server, attaches no token to emitted data and limits redirects to none. It polls durable snapshots every five seconds and reconnects event streams with bounded backoff.

- [ ] **Step 4: Implement monotonic merge and freshness state**

The aggregator keys intervals by stable ID, accepts only higher revision or later observedAt for equal revision, tombstones removals within the current window and computes freshness per source. Browser events carry a global sequence ID and source sequence metadata.

- [ ] **Step 5: Test PTH-down degradation and recovery**

Docker samples continue while PTH is unavailable; PTH lanes freeze and show stale/unavailable. Recovery snapshot reconciles without page reload. The monitor never calls PTH write routes.

- [ ] **Step 6: Run integration tests and commit**

Run: `npx vitest run test/unit/docker-monitor-pth-client.test.ts test/unit/docker-monitor-runtime-aggregator.test.ts test/pth-composition/runtime-observatory.integration.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add deploy/docker-monitor/pth-client.js deploy/docker-monitor/runtime-aggregator.js deploy/docker-monitor/server.js test/unit/docker-monitor-pth-client.test.ts test/unit/docker-monitor-runtime-aggregator.test.ts test/pth-composition/runtime-observatory.integration.test.ts
git commit -m "feat(observe): reconcile docker and pth runtime streams"
```

---

### Task 5: C-Layout Gantt and Resource Line Charts

**Files:**
- Create: `deploy/docker-monitor/ui-state.js`
- Create: `deploy/docker-monitor/charts.js`
- Modify: `deploy/docker-monitor/index.html`
- Create: `test/unit/docker-monitor-ui-state.test.ts`
- Create: `test/unit/docker-monitor-charts.test.ts`
- Create: `test/browser/runtime-observatory.test.ts`

**Interfaces:**
- Consumes: browser runtime snapshot/deltas from Task 4.
- Produces: shared time-window state, hierarchical Gantt model, resource-series model, selection/details model and rendered C-layout page.
- Produces for N33: `?embed=1&base=/observe` mode with the same charts/state and no duplicated renderer.

- [ ] **Step 1: Write pure UI state tests**

Test 15m/1h/custom windows, intake/optimize/run filters, pause/resume, selected interval, hierarchy collapse, zoom from resource brush, stale source shading and event replay. The same `windowStart/windowEnd` object feeds both charts.

- [ ] **Step 2: Run tests and confirm UI model is absent**

Run: `npx vitest run test/unit/docker-monitor-ui-state.test.ts test/unit/docker-monitor-charts.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement SVG Gantt and Canvas resource charts**

Gantt lanes are Job → Task → Intake/Professional Stage, with service lanes below. Resource chart draws CPU/RSS/Heap/Network against the same x-scale. Null sample ranges render gaps; stale ranges render shaded overlays. No CDN or frontend dependency is introduced.

- [ ] **Step 4: Implement linked interaction and details panel**

Clicking a bar selects the same time window on resource charts and displays Worker, Role, Batch, Trace, retry, error and usage. Brushing the resource chart updates the Gantt window. Keyboard navigation and textual summaries cover non-pointer access.

- [ ] **Step 5: Add validated embed mode**

`embed=1` hides only the standalone chrome. A `base` value must be a same-origin absolute path without scheme, host, `..` or encoded slash; snapshot/events resolve under that base. Embed mode remains GET/SSE-only and cannot receive Operator Session or control state.

- [ ] **Step 6: Add browser acceptance tests**

Verify initial snapshot, live upsert, reconnect, pause, hierarchy, linked zoom, missing data, stale state and Docker/PTH unavailable banners. Check that page source/local storage contains no token or Docker socket path.

- [ ] **Step 7: Run and commit**

Run: `npx vitest run test/unit/docker-monitor-ui-state.test.ts test/unit/docker-monitor-charts.test.ts test/browser/runtime-observatory.test.ts`

Expected: PASS, zero skipped tests.

```bash
git add deploy/docker-monitor/ui-state.js deploy/docker-monitor/charts.js deploy/docker-monitor/index.html test/unit/docker-monitor-ui-state.test.ts test/unit/docker-monitor-charts.test.ts test/browser/runtime-observatory.test.ts
git commit -m "feat(observe): render linked gantt and resource charts"
```

---

### Task 6: Alerts, Long-Run Limits, and N30 Acceptance Authority

**Files:**
- Create: `deploy/docker-monitor/alerts.js`
- Create: `scripts/eval-n30-runtime-observatory.ts`
- Create: `scripts/accept-n30-runtime-observatory.ts`
- Create: `test/unit/docker-monitor-alerts.test.ts`
- Create: `test/pth-composition/runtime-observatory-long-run.test.ts`
- Create: `docs/pth/n30-runtime-observatory-report.md`
- Create: `docs/pth/n30-runtime-observatory-envelope.json`
- Modify: `docs/README.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: read-only alerts, latency/resource metrics, sabotage probes and commit-bound N30 acceptance envelope.

- [ ] **Step 1: Write alert positive and negative probes**

Cover heartbeat stale/dead, queue backlog, CPU/RSS threshold, task timeout and intake/professional stage stall. Alerts include source, interval and evidence window; they never invoke control APIs.

- [ ] **Step 2: Write an eight-hour simulated sampling test**

Advance a fake clock through 14,400 two-second samples. Assert ring/sample/event memory stays under fixed limits, stale transitions occur at exact boundaries and time-axis drift is no more than one sample period.

- [ ] **Step 3: Implement alert evaluator and observatory metrics**

Metrics include exact denominators and P50/P95/P99 latency for resource, activity and durable timeline. Zero samples, NaN, missing probes or any write-call observation are NO-GO.

- [ ] **Step 4: Add sabotage cases**

Sabotage one boundary at a time: unbounded ring, zero-filled missing metric, cross-tenant interval, token in browser payload, dropped terminal delta without reconcile, stale source shown fresh, chart scale divergence and alert triggering a control call. Each must flip its mapped gate.

- [ ] **Step 5: Implement the acceptance driver**

The driver records evaluated commit, clean tree, focused/full/lint/build, real Docker+PTH composition, long-run result, browser result and skip manifest. Any unavailable required environment is `EVALUATION-INCOMPLETE`; any started failing gate is NO-GO.

- [ ] **Step 6: Run authority gates**

Run: `node --import tsx scripts/eval-n30-runtime-observatory.ts`

Run again and compare byte-for-byte.

Run: `npx vitest run test/unit/docker-monitor-*.test.ts test/pth-contracts/runtime-observation.test.ts test/pth-application/runtime-observation-facade.pg.test.ts test/pth-composition/runtime-observatory.integration.test.ts test/pth-composition/runtime-observatory-long-run.test.ts test/browser/runtime-observatory.test.ts --reporter=json --outputFile /tmp/n30-focused.json`

Run: `npm test -- --reporter=json --outputFile /tmp/n30-full.json`

Run: `npm run lint`

Run: `npm run build`

Run: `node --import tsx scripts/accept-n30-runtime-observatory.ts`

Expected: GO only when latency, security, resource, browser and all command gates pass with no new skips.

- [ ] **Step 7: Commit evaluator, then report**

```bash
git add deploy/docker-monitor/alerts.js scripts/eval-n30-runtime-observatory.ts scripts/accept-n30-runtime-observatory.ts test/unit/docker-monitor-alerts.test.ts test/pth-composition/runtime-observatory-long-run.test.ts
git commit -m "test(n30): add runtime observatory authority gate"
```

Generate the report/envelope on that commit, then:

```bash
git add docs/pth/n30-runtime-observatory-report.md docs/pth/n30-runtime-observatory-envelope.json docs/README.md TODO.md
git commit -m "docs(n30): publish runtime observatory acceptance"
```
