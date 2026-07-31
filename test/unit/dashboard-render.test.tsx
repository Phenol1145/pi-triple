// test/unit/dashboard-render.test.tsx — Dashboard 焦点布局渲染测试（ink-testing-library）
// 证据：仅焦点表展开 DataTable（非焦点表只有标题行）、水平聚焦栏固定 1 行、
// detail/提示区固定空间、滚动指示仅焦点表显示。
// 数据：12 模板 / 6 会话 / 112 追踪；height=17 → cap = max(2, 17-10) = 7 数据行。
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "ink-testing-library";

// ── 确定性 mock ────────────────────────────────────────────
// 组件图内所有 node:child_process 使用者仅用 spawnSync（dashboard/session-menu/tmux）。
vi.mock("node:child_process", () => ({
  spawnSync: () => ({ status: 0, stdout: "v0.1.0\n" }),
}));

vi.mock("../../src/ptl/config.js", () => {
  const TEMPLATES = Array.from({ length: 12 }, (_, i) => ({
    id: `tid-${i}`,
    alias: `tpl-${i}`,
    isDefault: i === 0,
    config: { alias: `tpl-${i}`, model: "m1", workLoop: { id: "wl-main" }, skills: [], extensions: [] },
  }));
  return {
    loadConfig: () => ({ version: 1, defaultTemplate: "tid-0", templates: {}, dataDir: "/tmp/pi-dashboard-test" }),
    listTemplates: () => TEMPLATES,
  };
});

vi.mock("../../src/ptl/session/session-store.js", () => {
  const SESSIONS = Array.from({ length: 6 }, (_, i) => ({
    id: `sess-${i}`,
    kind: "session",
    workloop: "wl-main",
    templateId: "tid-0",
    templateAlias: "tpl-0",
    status: i < 3 ? "running" : "stopped",
    timestamp: `2026-07-31T00:0${i}:00Z`,
    summary: `run ${i}`,
    detail: { region: "us", model: "m1", cost: "0.1" },
  }));
  const TRACES = Array.from({ length: 112 }, (_, i) => ({
    id: `trace-${i}`,
    kind: "trace",
    workloop: "wl-main",
    templateId: "tid-0",
    timestamp: `2026-07-31T00:00:0${i % 10}Z`,
    summary: `bid ${i}`,
    detail: {},
  }));
  return { listAllSessions: () => SESSIONS, listAllTraces: () => TRACES };
});

import { DashboardPage } from "../../src/ptl/tui-pit/dashboard.js";

afterEach(cleanup);

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const HEIGHT = 17; // 24 行终端 safeH=17 → cap = max(2, 17-10) = 7

describe("DashboardPage 焦点布局", () => {
  it("初始焦点 Templates：仅焦点表展开（cap=7 数据行），非焦点表只有标题，聚焦栏/Detail/提示齐全", async () => {
    const app = render(<DashboardPage width={100} height={HEIGHT} />);
    await tick(80);
    const frame = app.lastFrame() ?? "";

    // 三个标题行
    expect(frame).toContain("Templates (12) ❯");
    expect(frame).toContain("Sessions (6)");
    expect(frame).toContain("Trace (112)");

    // 仅焦点表渲染 DataTable：TENANT 表头 + 恰好 7 数据行（cap=7）
    expect(frame).toContain("TENANT");
    expect(frame).toContain("tpl-0");
    expect(frame).toContain("tpl-6");
    expect(frame).not.toContain("tpl-7");

    // 非焦点表无表头/数据行
    expect(frame).not.toContain("LOOP");
    expect(frame).not.toContain("sess-0");
    expect(frame).not.toContain("trace-0");

    // 滚动指示仅焦点表（12 > 7）
    expect(frame).toContain("▾ 1-7/12");

    // 水平聚焦栏（固定 1 行）：当前聚焦对象一行摘要
    expect(frame).toContain("❯ 模板");
    expect(frame).toContain("tpl-0 ★默认");
    expect(frame).toContain("wl-main");

    // Detail 区与提示行未被挤压
    expect(frame).toContain("Detail · 模板");
    expect(frame).toContain("ID: tid-0");
    expect(frame).toContain("Tab 切换焦点");
  });

  it("Tab → Sessions 焦点：Sessions 展开、Templates 折叠为标题行、聚焦栏切换、无滚动指示", async () => {
    const app = render(<DashboardPage width={100} height={HEIGHT} />);
    await tick();
    app.stdin.write("\t");
    await tick();
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Sessions (6) ❯");
    expect(frame).toContain("LOOP"); // Sessions 表头出现
    expect(frame).toContain("sess-0");
    expect(frame).toContain("sess-5"); // 6 ≤ cap → 全部可见
    expect(frame).not.toContain("sess-6");
    expect(frame).not.toContain("TENANT"); // Templates 折叠：无表头
    expect(frame).not.toContain("tid-0"); // 模板详情/行全部收起

    // 全部列表 ≤ cap 或非焦点 → 无任何滚动指示
    expect(frame).not.toContain("▾");

    // 聚焦栏 + Detail 跟随焦点
    expect(frame).toContain("❯ 会话");
    expect(frame).toContain("Detail · 会话");
  });

  it("Tab×2 → Trace 焦点：112 条滚动指示 ▾ 1-7/112，非焦点表仅标题", async () => {
    const app = render(<DashboardPage width={100} height={HEIGHT} />);
    await tick();
    app.stdin.write("\t");
    await tick();
    app.stdin.write("\t");
    await tick();
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("Trace (112) ❯");
    expect(frame).toContain("▾ 1-7/112");
    expect(frame).toContain("trace-0");
    expect(frame).toContain("trace-6");
    expect(frame).not.toContain("trace-7");
    expect(frame).not.toContain("TENANT");
    expect(frame).not.toContain("sess-0");
    expect(frame).toContain("❯ 追踪");
    expect(frame).toContain("Detail · 追踪");
  });

  it("↓ 移动选中：聚焦栏与详情跟随更新（tpl-0 → tpl-1），窗口未滚动", async () => {
    const app = render(<DashboardPage width={100} height={HEIGHT} />);
    await tick();
    app.stdin.write("\x1b[B");
    await tick();
    const frame = app.lastFrame() ?? "";

    expect(frame).toContain("模板 tpl-1 · workloop: wl-main");
    expect(frame).toContain("ID: tid-1");
    expect(frame).not.toContain("模板 tpl-0"); // 聚焦栏已切换（表格行无 "模板 " 前缀）
    // 既有 tableWindow 行为：选中 1 → offset=1，窗口随选中立即下移（可见行 2-8）
    expect(frame).toContain("▾ 2-8/12");
  });
});
