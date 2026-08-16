/**
 * config-types.ts —— Pi-Triple 中心配置类型（模块专项 ② 大文件拆分：自 config.ts 抽出）。
 */

export interface WorkLoopRef {
  id: string;
  version?: string;
  config?: unknown;
}

export interface InstantiationPolicy {
  count?: number;
  lifecycle?: "resident" | "on-demand" | "hybrid";
}

export interface TemplateConfig {
  alias: string;
  model?: string;
  provider?: string;
  thinking?: string;
  tools?: string;
  excludeTools?: string;
  systemPrompt?: string;
  skills?: string[];
  extensions?: string[];
  workLoop?: WorkLoopRef;
  instantiation?: InstantiationPolicy;
}

export interface PiTripleConfig {
  version: number;
  defaultTemplate: string;  // UUID
  dataDir: string;
  sharedDir: string;
  redis: string;
  gateway: { port: number };
  templates: Record<string, TemplateConfig>;  // key = UUID
  pth?: { url?: string; token?: string };
}

