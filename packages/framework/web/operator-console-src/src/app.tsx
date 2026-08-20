import { useState } from "preact/hooks";
import { Badge, Button, Card, PageHeader } from "./ui";

export type PageId = "overview" | "work" | "debug" | "memory" | "config";

interface PageDef {
  id: PageId;
  label: string;
  title: string;
  description: string;
}

const PAGES: ReadonlyArray<PageDef> = [
  {
    id: "overview",
    label: "Overview",
    title: "Overview",
    description: "Fleet health, recent activity, and operator alerts at a glance.",
  },
  {
    id: "work",
    label: "Work",
    title: "Work",
    description: "Tasks, sessions, and pipelines currently in flight.",
  },
  {
    id: "debug",
    label: "Debug",
    title: "Debug",
    description: "Inspection tools, traces, and diagnostic probes.",
  },
  {
    id: "memory",
    label: "Memory",
    title: "Memory",
    description: "Memory store contents, indexes, and retention state.",
  },
  {
    id: "config",
    label: "Config",
    title: "Config",
    description: "Effective configuration and runtime parameters.",
  },
];

export function App() {
  const [page, setPage] = useState<PageId>("overview");
  const active = PAGES.find((candidate) => candidate.id === page) ?? PAGES[0];

  return (
    <div class="shell">
      <header class="topbar">
        <div class="topbar__brand">
          <span class="topbar__logo" aria-hidden="true">
            PTL
          </span>
          <span class="topbar__title">Operator Console</span>
        </div>
        <div class="topbar__meta">
          <Badge tone="ok">loopback</Badge>
          <Badge tone="neutral">v1.4 T0 scaffold</Badge>
        </div>
      </header>
      <div class="shell__body">
        <nav class="sidebar" aria-label="Console pages">
          {PAGES.map((candidate) => (
            <Button
              key={candidate.id}
              variant={candidate.id === page ? "primary" : "ghost"}
              active={candidate.id === page}
              onClick={() => setPage(candidate.id)}
            >
              {candidate.label}
            </Button>
          ))}
        </nav>
        <main class="content">
          <section class="page" data-page-root={active.id} key={active.id}>
            <PageHeader title={active.title} subtitle={active.description} />
            <Card title={`${active.label} — placeholder`}>
              <p>
                This page is a v1.4 T0 scaffold placeholder. Feature content
                migrates from the legacy console in later tasks; server
                behavior is unchanged.
              </p>
            </Card>
          </section>
        </main>
      </div>
    </div>
  );
}
