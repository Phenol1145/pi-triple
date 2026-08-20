/**
 * container-runtime/index.ts —— 容器运行时适配器协议（v1 核心，R1–R3）。
 *
 * 只读契约：id/probe/version/socket/features + list/inspect/stats；
 * 选择协议：PI_CONTAINER_RUNTIME 显式优先 → socket 白名单自动 probe → 多可用 fail-closed；
 * 事实源：deploy/container-runtime-lock.json（允许运行时/版本约束/probe 定义）。
 */
export * from "./types.js";
export * from "./version-constraint.js";
export {
  CONTAINER_RUNTIME_IDS,
  CONTAINER_RUNTIME_LOCK_FILE,
  DEFAULT_CONTAINER_RUNTIME_LOCK_PATH,
  parseContainerRuntimeLock,
  loadContainerRuntimeLock,
  expandContainerRuntimeSocket,
  type ContainerRuntimeLock,
  type ContainerRuntimeLockEntry,
  type ContainerRuntimeProbeSpec,
  type ContainerRuntimeVersionSpec,
} from "./lock.js";
export {
  socketHttpGet,
  probeContainerRuntimeSocket,
  fetchContainerRuntimeVersion,
  createSocketContainerRuntimeCandidate,
  type SocketHttpResult,
} from "./socket-probe.js";
export {
  CONTAINER_RUNTIME_ENV,
  CONTAINER_RUNTIME_SOCKET_ENV,
  ContainerRuntimeSelectionError,
  buildContainerRuntimeCandidates,
  selectContainerRuntime,
  type ContainerRuntimeSelectionErrorCode,
  type ContainerRuntimeProbeRecord,
  type ContainerRuntimeSelection,
  type SelectContainerRuntimeOptions,
  type ContainerRuntimeCandidateBuild,
} from "./selection.js";
