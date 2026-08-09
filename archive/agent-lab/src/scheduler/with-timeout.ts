// ── 墙钟超时封装 ────────────────────────────────────────────────────

/**
 * 默认 winner 执行超时（毫秒）。
 * 与 DEFAULT_MARKET_CONFIG.execution.timeoutMs（src/config.ts）保持一致；
 * 配置路径：arena 调度参数 execution.timeoutMs → arena-scheduler 透传
 * timeoutMs → runner-sdk agents.run（本常量仅在未显式传入时兜底）。
 */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;

export interface TimeoutFailure {
  status: "failed";
  error: { code: "execution-timeout"; message: string; retryable: true };
}

/** 类型守卫：识别 withTimeout 的超时失败结果（而非业务返回值）。 */
export function isTimeoutFailure<T>(v: T | TimeoutFailure): v is TimeoutFailure {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.status === "failed" &&
    typeof o.error === "object" &&
    o.error !== null &&
    (o.error as Record<string, unknown>).code === "execution-timeout"
  );
}

/** 墙钟超时封装：超时返回 TimeoutFailure，不抛异常 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | TimeoutFailure> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<TimeoutFailure>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            status: "failed",
            error: {
              code: "execution-timeout",
              message: `execution timed out after ${timeoutMs}ms`,
              retryable: true,
            },
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
