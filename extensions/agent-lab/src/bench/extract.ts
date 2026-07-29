export function extractCode(raw: string, entryPoint: string): string {
  const text = (raw ?? "").trimEnd();
  if (!text.trim()) return "";
  // 1. 围栏 ```python ... ``` 或 ``` ... ```（保留缩进，只去尾部空白）
  const fence = text.match(/```(?:python)?\s*\n?([\s\S]*?)```/i);
  if (fence && fence[1].trimEnd()) return fence[1].trimEnd();
  // 2. 从 def <entry_point> 到末尾
  const defIdx = text.indexOf(`def ${entryPoint}`);
  if (defIdx >= 0) return text.slice(defIdx).trimEnd();
  // 3. 整个输出
  return text;
}
