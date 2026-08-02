import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseEbnf, validateAgainstGrammar } from "./ebnf.ts";
import type { EbnfGrammar } from "./ebnf.ts";
import type { MemoryEntry } from "./entry.ts";
import { AXIOM_RULE_ID, isAxiom, validateEntryStructure } from "./entry.ts";

export interface CompiledRule {
  ruleId: string;
  version: number;
  grammar: EbnfGrammar;
  entryName: string;
  compiledAt: number;
  ebnfText: string;
}

interface RuleFile {
  entry: MemoryEntry;
  compiled?: CompiledRule;
  error?: string;
}

export class RuleRegistry {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private axiomPath(): string {
    return `${this.dir}/axiom.json`;
  }

  private rulePath(ruleId: string): string {
    return `${this.dir}/rules/${ruleId}.json`;
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    const rulesDir = `${this.dir}/rules`;
    if (!existsSync(rulesDir)) {
      mkdirSync(rulesDir, { recursive: true });
    }
  }

  private atomicWrite(filePath: string, data: unknown): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, filePath);
  }

  private readJson<T>(filePath: string): T | undefined {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  }

  bootstrapAxiom(): void {
    this.ensureDir();
    if (existsSync(this.axiomPath())) return;
    const now = Date.now();
    const entry: MemoryEntry = {
      id: AXIOM_RULE_ID,
      kind: "axiom",
      anchors: ["system.root"],
      content: "axiom",
      status: "official",
      meta: {
        version: 1,
        createdAt: now,
        updatedAt: now,
        sourceTraces: [],
        hitCount: 0,
      },
    };
    const compiled: CompiledRule = {
      ruleId: AXIOM_RULE_ID,
      version: 1,
      grammar: { productions: [] },
      entryName: AXIOM_RULE_ID,
      compiledAt: now,
      ebnfText: "axiom",
    };
    this.atomicWrite(this.axiomPath(), { entry, compiled });
  }

  registerRule(entry: MemoryEntry): string[] {
    const structureErrors = validateEntryStructure(entry);
    if (structureErrors.length > 0) return structureErrors;
    if (entry.kind !== "rule") return [`kind must be "rule", got "${entry.kind}"`];

    const result = parseEbnf(entry.content);
    if (!result.ok) {
      return result.errors.map((e) => e.message);
    }

    const entryName = result.grammar.productions[0]?.name ?? entry.id;
    const compiled: CompiledRule = {
      ruleId: entry.id,
      version: entry.meta.version,
      grammar: result.grammar,
      entryName,
      compiledAt: Date.now(),
      ebnfText: entry.content,
    };

    this.ensureDir();
    this.atomicWrite(this.rulePath(entry.id), { entry, compiled });
    return [];
  }

  resolveRule(ruleId: string): CompiledRule | undefined {
    const filePath = ruleId === AXIOM_RULE_ID ? this.axiomPath() : this.rulePath(ruleId);
    const data = this.readJson<RuleFile>(filePath);
    if (!data) return undefined;

    // Handle legacy format where the file is a raw MemoryEntry (no wrapper)
    const ruleFile: RuleFile = data.entry ? data : { entry: data as unknown as MemoryEntry };

    if (ruleFile.compiled) return ruleFile.compiled;
    if (ruleFile.error) return undefined;

    const entry = ruleFile.entry;

    // Axiom: return a CompiledRule with minimal grammar
    if (isAxiom(entry)) {
      const compiled: CompiledRule = {
        ruleId: AXIOM_RULE_ID,
        version: entry.meta.version,
        grammar: { productions: [] },
        entryName: AXIOM_RULE_ID,
        compiledAt: Date.now(),
        ebnfText: entry.content,
      };
      this.atomicWrite(filePath, { entry, compiled });
      return compiled;
    }

    // On-the-fly compilation
    const result = parseEbnf(entry.content);
    if (!result.ok) {
      this.atomicWrite(filePath, { entry, error: result.errors.map((e) => e.message).join("; ") });
      return undefined;
    }

    const compiled: CompiledRule = {
      ruleId: entry.id,
      version: entry.meta.version,
      grammar: result.grammar,
      entryName: result.grammar.productions[0]?.name ?? entry.id,
      compiledAt: Date.now(),
      ebnfText: entry.content,
    };
    this.atomicWrite(filePath, { entry, compiled });
    return compiled;
  }

  updateRule(entry: MemoryEntry): string[] {
    // Parse EBNF first — fail early, old version untouched
    const result = parseEbnf(entry.content);
    if (!result.ok) {
      return result.errors.map((e) => e.message);
    }

    // Get current rule to determine next version
    const current = this.resolveRule(entry.id);
    if (!current) {
      return [`rule not found: ${entry.id}`];
    }
    const nextVersion = current.version + 1;

    const entryName = result.grammar.productions[0]?.name ?? entry.id;
    const compiled: CompiledRule = {
      ruleId: entry.id,
      version: nextVersion,
      grammar: result.grammar,
      entryName,
      compiledAt: Date.now(),
      ebnfText: entry.content,
    };

    this.ensureDir();
    this.atomicWrite(this.rulePath(entry.id), {
      entry: { ...entry, meta: { ...entry.meta, version: nextVersion, updatedAt: Date.now() } },
      compiled,
    });
    return [];
  }

  validateContent(entry: MemoryEntry): string[] {
    // Axiom exemption (self-referential)
    if (isAxiom(entry)) return [];

    if (!entry.ruleRef) {
      return ["ruleRef is required for content validation"];
    }

    const compiled = this.resolveRule(entry.ruleRef);
    if (!compiled) {
      const filePath = entry.ruleRef === AXIOM_RULE_ID ? this.axiomPath() : this.rulePath(entry.ruleRef);
      if (!existsSync(filePath)) {
        return [`rule not found: ${entry.ruleRef}`];
      }
      const data = this.readJson<RuleFile>(filePath);
      if (data?.error) {
        return [data.error];
      }
      return [`rule not found: ${entry.ruleRef}`];
    }

    return validateAgainstGrammar(compiled.grammar, compiled.entryName, entry.content);
  }
}
