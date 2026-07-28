/**
 * pit/args — CLI 参数解析 + 子命令白名单
 */

/** 有子命令语义的命令白名单（第二个位置参数 = subcommand） */
export const SUBCOMMAND_COMMANDS = new Set(["tenant", "shared", "config"]);

export function parseArgs(args: string[]): { command: string; subcommand?: string; flags: Record<string, string>; passthrough: string[] } {
  const flags: Record<string, string> = {};
  const passthrough: string[] = [];
  let command = "";
  let subcommand = "";
  let i = 0;

  const VALUED_FLAGS = new Set(["tenant", "project", "model", "provider", "thinking", "name"]);

  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (VALUED_FLAGS.has(key)) {
        const val = args[i + 1];
        if (val === undefined || val.startsWith("--")) {
          throw new Error(`flag --${key} requires a value`);
        }
        flags[key] = val;
        i++;
      } else if (key === "json") {
        flags[key] = "true";
      } else {
        flags[key] = "true";
      }
    } else if (!command) {
      command = arg;
    } else if (!subcommand && !arg.startsWith("-") && SUBCOMMAND_COMMANDS.has(command)) {
      subcommand = arg;
    } else {
      passthrough.push(arg);
    }
    i++;
  }

  return { command, subcommand, flags, passthrough };
}
