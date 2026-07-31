// test/unit/session-state.test.ts — task 2: 会话状态机（classifySession / isPidAlive）+ name 消毒
import { describe, it, expect } from "vitest";
import { classifySession, isPidAlive } from "../../src/ptl/session-state.js";
import { validateSessionName } from "../../src/ptl/tmux.js";

describe("session-state", () => {
  it("isPidAlive：正数 pid 视为存活（kill(pid,0) 探测；测试不依赖真实进程——负数/0/undefined 返回 false）", () => {
    expect(isPidAlive(undefined)).toBe(false);
    expect(isPidAlive(null)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    // 真实存活进程：当前进程 pid
    expect(isPidAlive(process.pid)).toBe(true);
    // 大概率不存在的 pid
    expect(isPidAlive(2147483647)).toBe(false);
  });

  it("classifySession 四态判定", () => {
    // running：tmux 在 && pid 存活
    expect(classifySession({ exists: true, pid: process.pid }, { pid: process.pid })).toBe("running");
    // empty：tmux 在 && pid 死（退化：currentCommand 是 shell）
    expect(classifySession({ exists: true, pid: 2147483647 }, { pid: 2147483647 })).toBe("empty");
    expect(classifySession({ exists: true, pid: null, currentCommand: "zsh" }, { pid: null })).toBe("empty");
    // orphan：tmux 无 && 注册表有
    expect(classifySession({ exists: false }, { pid: 42 })).toBe("orphan");
    // absent：tmux 无 && 注册表无
    expect(classifySession({ exists: false }, null)).toBeNull();
  });

  it("退化路径：pid 缺失时非 shell 当前命令不算 empty", () => {
    expect(classifySession({ exists: true, pid: null, currentCommand: "pi" }, { pid: null })).toBeNull();
  });
});

describe("validateSessionName", () => {
  it("合法名通过；非法字符返回错误消息", () => {
    expect(validateSessionName("local-abc_1")).toBeNull();
    expect(validateSessionName("a/b")).toBeTruthy();
    expect(validateSessionName("a b")).toBeTruthy();
    expect(validateSessionName("a:b")).toBeTruthy();
    expect(validateSessionName("")).toBeTruthy();
    expect(validateSessionName("a\nb")).toBeTruthy();
  });
});
