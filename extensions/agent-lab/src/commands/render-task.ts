// /lab task 与 /lab agent selector 的渲染纯函数（简单文本，参照 render-scheduler.ts 风格）。

export function renderTaskPublish(r: { id: string; templateId: string; labels: string[]; createdAt: number }): string {
  return `任务已发布: ${r.id}\n模板: ${r.templateId}\n标签: ${r.labels.join(", ")}\n创建: ${new Date(r.createdAt).toISOString()}`;
}

export function renderTaskList(rows: Array<{ id: string; status: string; templateId: string }>): string {
  if (rows.length === 0) return "任务池为空";
  return rows.map((r) => `${r.id}  [${r.status}]  ${r.templateId}`).join("\n");
}

export function renderTaskStatus(t: { id: string; status: string; claimedBy?: string; claimsCount?: number; rejects?: Array<{ agentId: string; reason: string }> }): string {
  const lines = [`${t.id}  [${t.status}]`, ...(t.claimedBy ? [`认领: ${t.claimedBy}`] : []), ...(t.claimsCount !== undefined ? [`认领次数: ${t.claimsCount}`] : [])];
  if (t.rejects && t.rejects.length > 0) lines.push(`拒绝记录: ${t.rejects.map((r) => `${r.agentId}(${r.reason})`).join("; ")}`);
  return lines.join("\n");
}

export function renderTaskRequeue(r: { id: string; status: string }): string {
  return `任务 ${r.id} 已重新入池 [${r.status}]（排除名单已清、认领计数已重置）`;
}

export function renderSelectorSet(agentId: string, sel: { labelPatterns: string[]; textPattern?: string }): string {
  return `agent ${agentId} 分选器已更新: 标签 ${sel.labelPatterns.join("|")}${sel.textPattern ? `, 文本 ${sel.textPattern}` : ""}`;
}
