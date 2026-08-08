/**
 * sdk-paths.ts — SDK 凭据/模型配置路径解析（PTL/PTH 凭据统一）
 *
 * 背景：pi SDK 的 ModelRuntime.create() 默认读 ~/.pi/agent（getAgentDir），而 PTL 会话
 * 用 PI_CODING_AGENT_DIR 指向模板目录（auth.json/models.json/models-store.json 同源）。
 * PTH 主进程与 kernel 子进程继承该 env 时，必须显式传入路径——否则部署在异机/容器
 * （无 ~/.pi/agent 或不同步）时凭据分叉。
 *
 * 本文件是唯一出口：所有 ModelRuntime.create() 调用点统一走此解析。
 */
import path from "node:path";

export interface SdkConfigPaths {
  authPath?: string;
  modelsPath?: string;
  modelsStorePath?: string;
}

/**
 * 解析 SDK 配置路径：PI_CODING_AGENT_DIR 设置时指向该目录（与 PTL 同源）；
 * 未设置时返回空（SDK 回退默认 ~/.pi/agent）。
 */
export function resolveSdkConfigPaths(): SdkConfigPaths {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) return {};
  return {
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
  };
}
