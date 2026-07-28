import { spawn } from "node:child_process";
import path from "node:path";
import type { PlatformAdapter, ExecOpts, ExecResult } from "./types.js";

export function createWin32Adapter(): PlatformAdapter {
  const shellPath = process.env.COMSPEC ?? "powershell.exe";
  const isPowerShell = shellPath.toLowerCase().includes("powershell");

  return {
    os: "win32",
    arch: process.arch === "arm64" ? "arm64" : "x64",

    shell: {
      execute(command: string, opts: ExecOpts): Promise<ExecResult> {
        return new Promise((resolve, reject) => {
          const args = isPowerShell
            ? ["-NoProfile", "-Command", command]
            : ["/c", command];
          const child = spawn(shellPath, args, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            signal: opts.signal,
          });

          let stdout = "";
          let stderr = "";
          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;

          if (opts.timeout) {
            timer = setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
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
        return `"${arg.replace(/"/g, '""')}"`;
      },

      async killProcessTree(pid: number): Promise<void> {
        const { execSync } = await import("node:child_process");
        try { execSync(`taskkill /PID ${pid} /T /F`); } catch {}
      },
    },

    fs: {
      resolve: (...segments: string[]) => path.win32.resolve(...segments),

      isPathTraversal(base: string, target: string): boolean {
        const resolved = path.win32.resolve(target).toLowerCase();
        const resolvedBase = path.win32.resolve(base).toLowerCase();
        return !resolved.startsWith(resolvedBase + "\\") && resolved !== resolvedBase;
      },

      pathPolicy: {
        caseSensitive: false,
        reservedNames: ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"],
        maxLength: 260,
      },
    },

    process: {
      signal: { graceful: "SIGBREAK" as NodeJS.Signals, force: "SIGKILL" },
      supervisor: "pm2",
    },

    env: {
      normalize: (key: string) => key.toUpperCase(),
      pathSeparator: ";",
    },
  };
}
