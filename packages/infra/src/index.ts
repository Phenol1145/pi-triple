/**
 * @away_from/infra — 双侧（framework/pth）共用基础模块
 *
 * 由仓库根 shared 目录迁移而来（workspace/platform/model-router/observability/
 * credential-provider/sdk-adapter）。消费方统一走本 barrel：import { ... } from "@away_from/infra"。
 */
export { WorkspaceManager } from "./workspace/manager.js";
export {
  detectPlatform,
  type PlatformAdapter,
  type ExecOpts,
  type ExecResult,
  type PathPolicy,
  type Disposable,
} from "./platform/index.js";
export { createLogger, type Logger } from "./observability/logger.js";
export {
  EnvCredentialProvider,
  type CredentialProvider,
} from "./credential-provider.js";
export {
  ModelRouter,
  type ModelRouterConfig,
} from "./model-router/router.js";
export { resolveSdkConfigPaths, type SdkConfigPaths } from "./sdk-paths.js";
export * from "./sdk-adapter/index.js";
export * from "./container-runtime/index.js";
