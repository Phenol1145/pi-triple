import { describe, it, expect, vi } from "vitest";
import { CommandRegistry, parseInput, registerBuiltinCommands, type CommandContext } from "../../src/tui/commands.js";

function mockCtx(overrides?: Partial<CommandContext>): CommandContext {
  return {
    createSession: vi.fn(),
    switchSession: vi.fn(),
    listSessions: () => [],
    abort: vi.fn(),
    setModel: vi.fn(),
    getLastAssistantMessage: () => null,
    copyToClipboard: vi.fn().mockResolvedValue(false),
    quit: vi.fn(),
    print: vi.fn(),
    ...overrides,
  };
}

describe("parseInput", () => {
  it("parses normal text", () => {
    expect(parseInput("hello")).toEqual({ type: "prompt", text: "hello" });
  });

  it("parses ! bash (send to agent)", () => {
    expect(parseInput("!ls -la")).toEqual({ type: "bash", command: "ls -la", sendToAgent: true });
  });

  it("parses !! bash (no send)", () => {
    expect(parseInput("!!ls -la")).toEqual({ type: "bash", command: "ls -la", sendToAgent: false });
  });

  it("!! matched before !", () => {
    const r = parseInput("!!echo hi");
    expect(r).toEqual({ type: "bash", command: "echo hi", sendToAgent: false });
  });

  it("trims leading space after !", () => {
    expect(parseInput("! ls")).toEqual({ type: "bash", command: "ls", sendToAgent: true });
  });

  it("bare ! shows usage", () => {
    expect(parseInput("!")).toEqual({ type: "error", text: "Usage: !<command>" });
  });

  it("bare !! shows usage", () => {
    expect(parseInput("!!")).toEqual({ type: "error", text: "Usage: !!<command>" });
  });

  it("parses /command", () => {
    expect(parseInput("/new")).toEqual({ type: "command", command: "new", args: "" });
  });

  it("parses /command with args", () => {
    expect(parseInput("/switch abc")).toEqual({ type: "command", command: "switch", args: "abc" });
  });

  it("escapes // to literal /", () => {
    expect(parseInput("//path/to/file")).toEqual({ type: "prompt", text: "/path/to/file" });
  });

  it("empty input", () => {
    expect(parseInput("")).toEqual({ type: "empty" });
  });
});

describe("CommandRegistry", () => {
  it("registers and executes commands", async () => {
    const reg = new CommandRegistry();
    const fn = vi.fn();
    reg.register({ name: "test", description: "test cmd", execute: fn });
    const handled = await reg.execute("test", "arg1", {} as any);
    expect(handled).toBe(true);
    expect(fn).toHaveBeenCalledWith("arg1", expect.anything());
  });

  it("returns false for unknown commands", async () => {
    const reg = new CommandRegistry();
    const handled = await reg.execute("nope", "", {} as any);
    expect(handled).toBe(false);
  });

  it("copy command prints error when no message", async () => {
    const reg = new CommandRegistry();
    registerBuiltinCommands(reg);
    const ctx = mockCtx({ getLastAssistantMessage: () => null });
    await reg.execute("copy", "", ctx);
    expect(ctx.print).toHaveBeenCalledWith("No assistant message to copy.");
  });

  it("copy command copies message via clipboard", async () => {
    const reg = new CommandRegistry();
    registerBuiltinCommands(reg);
    const copyFn = vi.fn().mockResolvedValue(true);
    const ctx = mockCtx({
      getLastAssistantMessage: () => "hello world",
      copyToClipboard: copyFn,
    });
    await reg.execute("copy", "", ctx);
    expect(copyFn).toHaveBeenCalledWith("hello world");
    expect(ctx.print).toHaveBeenCalledWith("[copied 11 chars]");
  });

  it("lists registered commands", () => {
    const reg = new CommandRegistry();
    reg.register({ name: "a", description: "A", execute: async () => {} });
    reg.register({ name: "b", description: "B", execute: async () => {} });
    expect(reg.list()).toHaveLength(2);
  });
});
