import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { DataTable } from "../../packages/framework/src/tui-shared/data-table.js";
import { tableWindow } from "../../packages/framework/src/tui-shared/hooks.js";

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

describe("DataTable 窗口滚动选择（Task 7 review 修复）", () => {
  it("cap < rowCount 且 offset > 0 时，回执经 offset 还原为绝对索引（无跳变）", async () => {
    // 模拟 dashboard 接线（Option B）：rows 为窗口切片、selectedIndex 为窗口相对，
    // onSelectionChange 回执按 offset + rel 还原为绝对索引。
    // 修复前：回执 rel 被直接当作绝对索引（setIndex(rel)）→ offset>0 时选中跳变。
    const ROWS6 = [0, 1, 2, 3, 4, 5].map((i) => ({ a: `r${i}` }));
    const reported: number[] = [];
    function WindowedTable({ abs }: { abs: number }) {
      const win = tableWindow(ROWS6, abs, 3); // cap=3 < 6 → 窗口滚动
      return (
        <DataTable
          columns={COLS}
          rows={win.rows}
          selectable
          selectedIndex={abs - win.offset}
          onSelectionChange={(rel) => {
            reported.push(win.offset + rel);
          }}
        />
      );
    }

    const app = render(<WindowedTable abs={3} />); // 绝对 3 → offset 3 / 窗口内 rel 0
    await new Promise((r) => setTimeout(r, 0));
    expect(reported).toEqual([]); // 挂载首帧不上报

    // ↓ 移动：绝对 3→4（offset 仍 3，rel 0→1）→ 还原 4（修复前为 1，跳变）
    app.rerender(<WindowedTable abs={4} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(reported).toEqual([4]);

    // 窗口内继续 ↓：4→5（rel 1→2）→ 还原 5
    app.rerender(<WindowedTable abs={5} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(reported).toEqual([4, 5]);

    // 反方向：5→4（rel 2→1）→ 还原 4
    app.rerender(<WindowedTable abs={4} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(reported).toEqual([4, 5, 4]);

    // 窗口向下滚动边界：4→3（offset 3→3，rel 1→0）→ 还原 3
    app.rerender(<WindowedTable abs={3} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(reported).toEqual([4, 5, 4, 3]);

    // 窗口向上滚动边界：3→2（offset 3→2，rel 0→0，仅回调身份变化触发）→ 还原 2
    app.rerender(<WindowedTable abs={2} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(reported).toEqual([4, 5, 4, 3, 2]);
  });
});
