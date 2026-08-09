// ptl-flow subflow 子图注册表
//
// subflow 节点通过 `flow: string` 引用已注册子图，或通过内联 FlowDef 定义。
// 本注册表提供命名解析，与 code-registry / effect-registry 模式一致。

import type { FlowDef } from "./schema.js";

export class SubflowRegistry {
  private defs = new Map<string, FlowDef>();

  /** 注册子 flow；重复注册抛错 */
  register(name: string, def: FlowDef): void {
    if (this.defs.has(name)) throw new Error(`subflow already registered: ${name}`);
    this.defs.set(name, def);
  }

  /** 获取子 flow；未注册抛错 */
  get(name: string): FlowDef {
    const def = this.defs.get(name);
    if (!def) throw new Error(`subflow not registered: ${name}`);
    return def;
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }
}

// 默认实例：引擎/校验共享
export const defaultSubflowRegistry = new SubflowRegistry();

export function registerSubflow(name: string, def: FlowDef): void {
  defaultSubflowRegistry.register(name, def);
}

export function resolveSubflow(name: string): FlowDef {
  return defaultSubflowRegistry.get(name);
}

export function hasSubflow(name: string): boolean {
  return defaultSubflowRegistry.has(name);
}
