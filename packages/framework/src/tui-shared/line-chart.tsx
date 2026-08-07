import React from "react";
import { Box, Text } from "ink";
import { layoutChart } from "./chart.js";

export function LineChart({ points, width, height, label }: { points: number[]; width: number; height: number; label?: string }) {
  const { rows } = layoutChart(points, width, height);
  return (
    <Box flexDirection="column">
      {label ? <Text bold>{label}</Text> : null}
      {rows.map((r, i) => <Text key={i}>{r}</Text>)}
    </Box>
  );
}
