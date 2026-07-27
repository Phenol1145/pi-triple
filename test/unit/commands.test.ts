import { describe, it, expect, vi } from "vitest";
import { CommandRegistry, parseInput } from "../../src/tui/commands.js";

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

  it("lists registered commands", () => {
    const reg = new CommandRegistry();
    reg.register({ name: "a", description: "A", execute: async () => {} });
    reg.register({ name: "b", description: "B", execute: async () => {} });
    expect(reg.list()).toHaveLength(2);
  });
});
