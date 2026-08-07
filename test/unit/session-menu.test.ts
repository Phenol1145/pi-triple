import { describe, it, expect } from "vitest";
import {
  sessionMenuCapabilities,
  buildSessionMenu,
  bareTmuxName,
  SESSION_MENU,
} from "../../src/ptl/tui-ptl/session-menu.js";
import type { SessionMenuHandlers } from "../../src/ptl/tui-ptl/session-menu.js";
import type { SessionRecord } from "../../src/ptl/session/session-provider.js";

function rec(over: Partial<SessionRecord>): SessionRecord {
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    kind: "session",
    workloop: "pi",
    templateId: "t1",
    templateAlias: "dev",
    status: "running",
    timestamp: "2026-07-01T00:00:00.000Z",
    summary: "● 运行中 · 3 事件",
    detail: {},
    ...over,
  };
}

describe("sessionMenuCapabilities", () => {
  it("pi 运行中 → 全量（含 stop）", () => {
    const caps = sessionMenuCapabilities(rec({}));
    expect(caps).toContain("attach");
    expect(caps).toContain("fork");
    expect(caps).toContain("stop");
    expect(caps).toContain("details");
  });

  it("pi 已停止 → 无 stop（其余保留）", () => {
    const caps = sessionMenuCapabilities(rec({ status: "stopped" }));
    expect(caps).not.toContain("stop");
    expect(caps).toContain("resume");
    expect(caps).toContain("fork");
  });

  it("非 pi（如 bidding）→ 仅 view（tree/details）", () => {
    const caps = sessionMenuCapabilities(rec({ workloop: "bidding" }));
    expect(caps).toEqual(["tree", "details"]);
  });
});

describe("buildSessionMenu", () => {
  const calls: string[] = [];
  const handlers: SessionMenuHandlers = {
    run: (op, id) => { calls.push(`run:${op}:${id.slice(0, 8)}`); },
    attach: (r) => { calls.push(`attach:${r.id.slice(0, 8)}`); },
    pickTemplate: (op, id) => { calls.push(`pickTemplate:${op}:${id.slice(0, 8)}`); },
    pickNode: (id) => { calls.push(`pickNode:${id.slice(0, 8)}`); },
    confirmStop: (r) => { calls.push(`confirmStop:${r.id.slice(0, 8)}`); },
  };

  it("按能力过滤：停止的 pi 会话无 stop 项", () => {
    const menu = buildSessionMenu(rec({ status: "stopped" }), handlers);
    expect(menu.map((n) => n.key)).toEqual(["r", "c", "v"]); // 无 x
    expect(menu[2]!.children?.map((n) => n.key)).toEqual(["t", "d"]);
  });

  it("非 pi 会话仅剩 view 组", () => {
    const menu = buildSessionMenu(rec({ workloop: "bidding" }), handlers);
    expect(menu.map((n) => n.key)).toEqual(["v"]);
  });

  it("叶子 action 分发到对应处理器", () => {
    const r = rec({});
    const menu = buildSessionMenu(r, handlers);
    // 进入 copy 组 → fork
    const copy = menu.find((n) => n.key === "c")!;
    const fork = copy.children!.find((n) => n.key === "f")!;
    fork.action!();
    expect(calls).toContain("pickTemplate:fork:aaaaaaaa");
    // view → details（run:show）
    const view = menu.find((n) => n.key === "v")!;
    view.children!.find((n) => n.key === "d")!.action!();
    expect(calls).toContain("run:show:aaaaaaaa");
    // run → attach
    const run = menu.find((n) => n.key === "r")!;
    run.children!.find((n) => n.key === "a")!.action!();
    expect(calls).toContain("attach:aaaaaaaa");
    // stop → confirmStop（dangerous 标记保留）
    const stop = menu.find((n) => n.key === "x")!;
    expect(stop.dangerous).toBe(true);
    stop.action!();
    expect(calls).toContain("confirmStop:aaaaaaaa");
    // branch → pickNode
    const branch = copy.children!.find((n) => n.key === "b")!;
    branch.action!();
    expect(calls).toContain("pickNode:aaaaaaaa");
  });

  it("SESSION_MENU 静态规格：run/copy/view/stop 四个根组", () => {
    expect(SESSION_MENU.map((n) => n.key)).toEqual(["r", "c", "v", "x"]);
  });
});

describe("bareTmuxName", () => {
  it("去掉 ptl- 前缀", () => {
    expect(bareTmuxName("ptl-dev-x1k2")).toBe("dev-x1k2");
    expect(bareTmuxName("dev-x1k2")).toBe("dev-x1k2");
  });
});
