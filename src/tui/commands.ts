// src/tui/commands.ts
// CommandRegistry + CommandContext + parseInput + built-in slash commands.
// Does NOT import app.tsx (dependency-direction constraint).
// Commands receive callbacks via CommandContext injected by the caller.

export interface CommandContext {
  createSession(): Promise<void>;
  switchSession(idPrefix: string): Promise<void>;
  listSessions(): Array<{ sessionId: string; state: string; model: string; project: string }>;
  abort(): Promise<void>;
  setModel(provider: string, model: string): void;
  getLastAssistantMessage(): string | null;
  copyToClipboard(text: string): Promise<boolean>;
  quit(): void;
  print(text: string): void;
}

export interface SlashCommand {
  name: string;
  description: string;
  execute(args: string, ctx: CommandContext): Promise<void>;
}

export type ParsedInput =
  | { type: "prompt"; text: string }
  | { type: "bash"; command: string; sendToAgent: boolean }
  | { type: "command"; command: string; args: string }
  | { type: "error"; text: string }
  | { type: "empty" };

export function parseInput(raw: string): ParsedInput {
  const input = raw.trim();
  if (!input) return { type: "empty" };

  // Escape: // → literal /
  if (input.startsWith("//")) {
    return { type: "prompt", text: input.slice(1) };
  }

  // Bash: !! must be checked before !
  if (input.startsWith("!!")) {
    const cmd = input.slice(2).trimStart();
    if (!cmd) return { type: "error", text: "Usage: !!<command>" };
    return { type: "bash", command: cmd, sendToAgent: false };
  }
  if (input.startsWith("!")) {
    const cmd = input.slice(1).trimStart();
    if (!cmd) return { type: "error", text: "Usage: !<command>" };
    return { type: "bash", command: cmd, sendToAgent: true };
  }

  // Slash command
  if (input.startsWith("/")) {
    const [cmd, ...rest] = input.slice(1).split(/\s+/);
    return { type: "command", command: cmd, args: rest.join(" ") };
  }

  return { type: "prompt", text: input };
}

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
  }

  async execute(name: string, args: string, ctx: CommandContext): Promise<boolean> {
    const cmd = this.commands.get(name);
    if (!cmd) return false;
    await cmd.execute(args, ctx);
    return true;
  }

  list(): SlashCommand[] {
    return [...this.commands.values()];
  }
}

/** Register all built-in slash commands */
export function registerBuiltinCommands(reg: CommandRegistry): void {
  reg.register({
    name: "new",
    description: "Create a new session",
    execute: async (_args, ctx) => {
      await ctx.createSession();
    },
  });

  reg.register({
    name: "sessions",
    description: "List all sessions",
    execute: async (_args, ctx) => {
      const sessions = ctx.listSessions();
      if (sessions.length === 0) {
        ctx.print("  (no sessions)");
      } else {
        for (const s of sessions) {
          ctx.print(`  ${s.sessionId.slice(0, 8)}  ${s.state}  ${s.model}  ${s.project}`);
        }
      }
    },
  });

  reg.register({
    name: "switch",
    description: "Switch to a session by ID prefix",
    execute: async (args, ctx) => {
      if (!args) {
        ctx.print("Usage: /switch <session-id-prefix>");
        return;
      }
      await ctx.switchSession(args);
    },
  });

  reg.register({
    name: "abort",
    description: "Abort current prompt",
    execute: async (_args, ctx) => {
      await ctx.abort();
    },
  });

  reg.register({
    name: "model",
    description: "Show or switch model",
    execute: async (args, ctx) => {
      if (!args) {
        ctx.print("Usage: /model <provider/model>");
        return;
      }
      const [provider, ...modelParts] = args.split("/");
      ctx.setModel(provider, modelParts.join("/"));
    },
  });

  reg.register({
    name: "copy",
    description: "Copy last assistant message to clipboard",
    execute: async (_args, ctx) => {
      const msg = ctx.getLastAssistantMessage();
      if (!msg) {
        ctx.print("No assistant message to copy.");
        return;
      }
      const ok = await ctx.copyToClipboard(msg);
      if (ok) {
        ctx.print(`[copied ${msg.length} chars]`);
      } else {
        ctx.print("Clipboard not available on this platform.");
      }
    },
  });

  reg.register({
    name: "help",
    description: "Show command help",
    execute: async (_args, ctx) => {
      ctx.print("\nCommands:");
      for (const cmd of reg.list()) {
        ctx.print(`  /${cmd.name.padEnd(12)} ${cmd.description}`);
      }
      ctx.print("\nBash:");
      ctx.print("  !<command>    Run and send output to agent");
      ctx.print("  !!<command>   Run without sending to agent");
      ctx.print("\nEscape:");
      ctx.print("  //text        Send literal text starting with /");
      ctx.print("\nKeys:");
      ctx.print("  Enter         Send  |  Alt+Enter / Ctrl+J  Newline");
      ctx.print("  Tab           Switch focus  |  Ctrl+C  Abort/Quit");
      ctx.print("  Ctrl+T        Toggle thinking  |  Ctrl+G  Toggle status detail");
    },
  });

  reg.register({
    name: "quit",
    description: "Exit Pi-Triple TUI",
    execute: async (_args, ctx) => {
      ctx.quit();
    },
  });
}
