import { describe, it, expect } from "vitest";
import { createMenu, menuStep, menuBreadcrumb, filterMenuByCapabilities } from "../../src/ptl/tui-shared/menu.js";
import type { MenuNode } from "../../src/ptl/tui-shared/menu.js";

const fired: string[] = [];

const ROOT: MenuNode[] = [
  { key: "r", label: "run", children: [
    { key: "a", label: "attach", capability: "attach", action: () => { fired.push("attach"); } },
    { key: "r", label: "resume", capability: "resume", action: () => { fired.push("resume"); } },
  ]},
  { key: "c", label: "copy", children: [
    { key: "f", label: "fork", capability: "fork", action: () => { fired.push("fork"); } },
    { key: "t", label: "transfer", capability: "transfer", action: () => { fired.push("transfer"); } },
  ]},
  { key: "x", label: "stop", capability: "stop", action: () => { fired.push("stop"); }, dangerous: true },
];

describe("menu", () => {
  it("menuStep 进入子菜单 / 执行叶子 / 返回", () => {
    let s = createMenu(ROOT);
    s = menuStep(s, "r").state;
    expect(menuBreadcrumb(s)).toContain("run");
    const r = menuStep(s, "a");
    expect(r.fired).toBeDefined();
    r.fired!();
    expect(fired).toContain("attach");
  });

  it("未知键忽略", () => {
    let s = createMenu(ROOT);
    s = menuStep(s, "zz").state;
    expect(menuBreadcrumb(s)).toBe("");
  });

  it("filterMenuByCapabilities 按 capability 过滤", () => {
    const filtered = filterMenuByCapabilities(ROOT, ["fork"]);
    expect(filtered.map((n) => n.key)).toEqual(["c"]);
    const onlyView = filterMenuByCapabilities([{ key: "v", label: "view", children: [] }], []);
    expect(onlyView).toHaveLength(1); // view 始终保留（children 空）
  });
});
