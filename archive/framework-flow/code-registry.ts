// ptl-flow code 节点函数注册表（白名单：flow 只能引用已注册函数）

export interface CodeFnContext {
  state: Readonly<Record<string, unknown>>;
  runId: string;
  nodeId: string;
  log: (msg: string) => void;
}

export type CodeFn = (args: Record<string, unknown>, ctx: CodeFnContext) => unknown | Promise<unknown>;

const registry = new Map<string, CodeFn>();

export function registerCodeFn(name: string, fn: CodeFn): void {
  if (registry.has(name)) throw new Error(`code fn already registered: ${name}`);
  registry.set(name, fn);
}

export function resolveCodeFn(name: string): CodeFn | undefined {
  return registry.get(name);
}

export function listCodeFns(): string[] {
  return [...registry.keys()];
}
