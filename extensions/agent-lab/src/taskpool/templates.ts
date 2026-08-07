import type { DatabaseSync } from "node:sqlite";

export interface ParamSpec { name: string; description?: string; required?: boolean }
export interface OutputContract { kind: "memory" | "file" | "report"; target: string }

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  labels: string[];
  params: ParamSpec[];
  protocol: string;
  acceptance: string;
  output: OutputContract;
  registeredBy: string;
  createdAt: number;
}

export type InstantiateResult =
  | { ok: true; text: string; labels: string[] }
  | { ok: false; error: string };

export class SqliteTemplateRegistry {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  register(t: TaskTemplate): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO task_templates
        (id, name, description, labels, params, protocol, acceptance, output, registered_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      t.id, t.name, t.description,
      JSON.stringify(t.labels), JSON.stringify(t.params),
      t.protocol, t.acceptance, JSON.stringify(t.output),
      t.registeredBy, t.createdAt,
    );
  }

  get(id: string): TaskTemplate | undefined {
    const row = this.db.prepare(`SELECT * FROM task_templates WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToTemplate(row) : undefined;
  }

  list(): TaskTemplate[] {
    const rows = this.db.prepare(`SELECT * FROM task_templates ORDER BY created_at`).all() as Array<Record<string, unknown>>;
    return rows.map(rowToTemplate);
  }

  instantiate(id: string, params: Record<string, string>, extraLabels: string[] = []): InstantiateResult {
    const t = this.get(id);
    if (!t) return { ok: false, error: `template not found: ${id}` };
    for (const p of t.params) {
      if (p.required && !(p.name in params)) {
        return { ok: false, error: `missing required param: ${p.name}` };
      }
    }
    let text = t.protocol;
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`<${k}>`, v);
    }
    return { ok: true, text, labels: [...t.labels, ...extraLabels] };
  }
}

function rowToTemplate(row: Record<string, unknown>): TaskTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    labels: JSON.parse(row.labels as string) as string[],
    params: JSON.parse(row.params as string) as ParamSpec[],
    protocol: row.protocol as string,
    acceptance: row.acceptance as string,
    output: JSON.parse(row.output as string) as OutputContract,
    registeredBy: row.registered_by as string,
    createdAt: row.created_at as number,
  };
}
