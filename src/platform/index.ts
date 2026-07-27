import type { PlatformAdapter } from "./types.js";
import { createPosixAdapter } from "./posix.js";
import { createWin32Adapter } from "./win32.js";

export type { PlatformAdapter, ExecOpts, ExecResult, PathPolicy, Disposable } from "./types.js";

export function detectPlatform(): PlatformAdapter {
  switch (process.platform) {
    case "win32":
      return createWin32Adapter();
    case "darwin":
      return createPosixAdapter("darwin");
    default:
      return createPosixAdapter("linux");
  }
}
