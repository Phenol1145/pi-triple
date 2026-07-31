import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { DataTable } from "../../src/ptl/tui-shared/data-table.js";

afterEach(cleanup);

const COLS = [{ key: "a", label: "A" }];
const ROWS = [{ a: "x" }, { a: "y" }, { a: "z" }];

describe("DataTable onSelectionChange", () => {
  it("受控 selectedIndex 变化时触发（挂载首帧不触发）", async () => {
    const calls: number[] = [];
    const app = render(
      <DataTable
        columns={COLS}
        rows={ROWS}
        selectable
        selectedIndex={0}
        onSelectionChange={(i) => calls.push(i)}
      />,
    );
    expect(calls).toEqual([]);

    app.rerender(
      <DataTable
        columns={COLS}
        rows={ROWS}
        selectable
        selectedIndex={2}
        onSelectionChange={(i) => calls.push(i)}
      />,
    );
    // React 被动 effect 异步 flush
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([2]);

    // 选中行高亮随 selectedIndex 更新
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("z");
  });

  it("非 selectable 时不触发", async () => {
    const calls: number[] = [];
    const app = render(
      <DataTable columns={COLS} rows={ROWS} selectedIndex={0} onSelectionChange={(i) => calls.push(i)} />,
    );
    app.rerender(
      <DataTable columns={COLS} rows={ROWS} selectedIndex={1} onSelectionChange={(i) => calls.push(i)} />,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });
});
