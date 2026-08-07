// packages/framework/src/tui-shared/chart.ts

export interface ChartLayout {
  rows: string[];
  yTicks: string[];
}

/** 归一化坐标 → 字符画布（y 轴 0-100% + 网格 + 折线点 ●） */
export function layoutChart(points: number[], width: number, height: number): ChartLayout {
  if (points.length === 0) {
    const rows = Array.from({ length: height }, (_, i) =>
      i === Math.floor(height / 2) ? "  (no data)" : "");
    return { rows, yTicks: ["100%", "50%", "0%"] };
  }
  const h = Math.max(3, height);
  const w = Math.max(10, width);
  // 画布宽：去掉 y 轴标签列（5 字符）
  const plotW = Math.max(4, w - 6);
  const plotH = h - 1; // 底行刻度
  const rows: string[] = [];
  for (let row = 0; row < plotH; row++) {
    const yNorm = row / (plotH - 1); // 0=顶
    let line = "";
    for (let col = 0; col < plotW; col++) {
      const xNorm = col / (plotW - 1);
      const idx = Math.min(points.length - 1, Math.round(xNorm * (points.length - 1)));
      const val = points[idx]!;
      const py = 1 - val; // 0-1（1=顶）
      const cellRow = Math.round(py * (plotH - 1));
      line += cellRow === row ? "●" : (row % 2 === 0 ? "·" : " ");
    }
    const tick = row === 0 ? "100%" : row === Math.floor(plotH / 2) ? " 50%" : row === plotH - 1 ? "  0%" : "    ";
    rows.push(`${tick} ${line}`);
  }
  // x 轴刻度行
  rows.push(`     ${"─".repeat(plotW)}`);
  return { rows, yTicks: ["100%", "50%", "0%"] };
}
