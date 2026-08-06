// src/ingest/tags.ts
// 路径推导标签（spec §4.1，纯函数零维护）。
// 规则：目录段原样 + 文件名去扩展名去日期前缀；不做大小写折叠/分词/同义归并
// （标签精化是记忆管理者角色后续工作）。锚点非空不变量：文件名标签恒存在。

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;

export function deriveTags(relPath: string): string[] {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return [];
  const file = parts[parts.length - 1]!;
  const extStripped = file.replace(/\.[^.]*$/, "");
  const dateStripped = extStripped.replace(DATE_PREFIX_RE, "");
  const stem = dateStripped.length > 0 ? dateStripped : extStripped;
  return [...parts.slice(0, -1), stem].filter((t) => t.length > 0);
}
