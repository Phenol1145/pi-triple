export interface ExecOpts {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface PathPolicy {
  caseSensitive: boolean;
  reservedNames: string[];
  maxLength: number;
}

export interface Disposable {
  dispose(): void;
}

export interface PlatformAdapter {
  os: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";

  shell: {
    execute(command: string, opts: ExecOpts): Promise<ExecResult>;
    getShellPath(): string;
    escapeArg(arg: string): string;
    killProcessTree(pid: number): Promise<void>;
  };

  fs: {
    resolve(...segments: string[]): string;
    isPathTraversal(base: string, target: string): boolean;
    pathPolicy: PathPolicy;
  };

  process: {
    signal: { graceful: NodeJS.Signals; force: NodeJS.Signals };
    supervisor: "systemd" | "launchd" | "windows-service" | "pm2";
  };

  env: {
    normalize(key: string): string;
    pathSeparator: string;
  };
}
