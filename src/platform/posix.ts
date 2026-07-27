import { spawn } from "node:child_process";
import path from "node:path";
import type { PlatformAdapter, ExecOpts, ExecResult } from "./types.js";

export function createPosixAdapter(os: "linux" | "darwin"): PlatformAdapter {
  const shellPath = process.env.SHELL ?? "/bin/bash";

  return {
    os,
    arch: process.arch === "arm64" ? "arm64" : "x64",

    shell: {
      execute(command: string, opts: ExecOpts): Promise<ExecResult> {
        return new Promise((resolve, reject) => {
          const child = spawn(shellPath, ["-c", command], {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            detached: true,
            signal: opts.signal,
          });

          let stdout = "";
          let stderr = "";
          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;

          if (opts.timeout) {
            timer = setTimeout(() => {
              timedOut = true;
              if (child.pid) {
                try { process.kill(-child.pid, "SIGKILL"); } catch {}
              }
            }, opts.timeout);
          }

          child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
          child.on("error", reject);
          child.on("close", (code) => {
            if (timer) clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
          });
        });
      },

      getShellPath: () => shellPath,

      escapeArg(arg: string): string {
        return `'${arg.replace(/'/g, "'\\''")}'`;
      },

      async killProcessTree(pid: number): Promise<void> {
        try { process.kill(-pid, "SIGTERM"); } catch {}
        await new Promise((r) => setTimeout(r, 2000));
        try { process.kill(-pid, "SIGKILL"); } catch {}
      },
    },

    fs: {
      resolve: (...segments: string[]) => path.posix.resolve(...segments),

      isPathTraversal(base: string, target: string): boolean {
        const resolved = path.posix.resolve(target);
        const resolvedBase = path.posix.resolve(base);
        return !resolved.startsWith(resolvedBase + "/") && resolved !== resolvedBase;
      },

      pathPolicy: {
        caseSensitive: true,
        reservedNames: [],
        maxLength: 4096,
      },
    },

    process: {
      signal: { graceful: "SIGTERM", force: "SIGKILL" },
      supervisor: os === "linux" ? "systemd" : "launchd",
    },

    env: {
      normalize: (key: string) => key,
      pathSeparator: ":",
    },
  };
}
