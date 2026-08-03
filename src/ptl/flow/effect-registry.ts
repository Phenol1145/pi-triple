// pit-flow effect 节点函数注册表（白名单 + 幂等）
//
// 与 code-registry 的差异：effect 承担确定性副作用（DB/外部写入），引擎侧
// 通过 flow_effects 幂等表保证 at-least-once——同一 (flow_run_id, node_id,
// idempotency_key) 命中则跳过不重复执行。

export interface EffectFnContext {
  state: Record<string, unknown>;
  runId: string;
  nodeId: string;
  idempotencyKey: string;
  log: (msg: string) => void;
}

export type EffectFn = (ctx: EffectFnContext) => Promise<unknown> | unknown;

export class EffectRegistry {
  private fns = new Map<string, EffectFn>();

  /** 注册 effect；重复注册抛错 */
  register(name: string, fn: EffectFn): void {
    if (this.fns.has(name)) throw new Error(`effect already registered: ${name}`);
    this.fns.set(name, fn);
  }

  /** 获取 effect；未注册抛错 */
  get(name: string): EffectFn {
    const fn = this.fns.get(name);
    if (!fn) throw new Error(`effect not registered: ${name}`);
    return fn;
  }

  has(name: string): boolean {
    return this.fns.has(name);
  }
}

// 默认实例：引擎通过它解析 effect（与 code-registry 模块级模式一致）
export const defaultEffectRegistry = new EffectRegistry();

export function registerEffect(name: string, fn: EffectFn): void {
  defaultEffectRegistry.register(name, fn);
}

export function resolveEffect(name: string): EffectFn {
  return defaultEffectRegistry.get(name);
}

export function hasEffect(name: string): boolean {
  return defaultEffectRegistry.has(name);
}
