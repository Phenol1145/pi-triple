/**
 * ptl-flow effect 节点函数注册表（白名单 + 幂等）。
 *
 * D2 effect 编写契约（ruling 1——所有 effect fn 必须遵守）：
 * 1. fn 内部按业务键幂等：同一业务键重复执行必须产生相同副作用，第二次起应为 no-op。
 * 2. args 只含稳定业务键字段：传给 effect fn 的参数必须是可重算、幂等的业务键
 *    （如 taskId、agentId），fn 内部可自行重算幂等 key，不得把运行时瞬态（如时间戳、
 *    随机数、内存指针）作为 args 的一部分。引擎侧 flow_effects 表保证
 *    at-least-once——同一 (flow_run_id, node_id, idempotency_key) 命中则跳过。
 *
 * 与 code-registry 的差异：effect 承担确定性副作用（DB/外部写入）。
 */

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
