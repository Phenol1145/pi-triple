/**
 * commands-types.ts —— CLI 命令结果类型（模块专项 ④ 断文件环：session-provider 只依赖本类型文件）。
 */
export interface CommandResult {
  ok: boolean;
  message: string;
  data?: any;
  error?: { code: string; message: string; candidates?: string[] };
  handoff?: { cmd: string; args: string[] };
}

