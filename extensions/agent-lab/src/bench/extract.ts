export function extractCode(raw: string, entryPoint: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  // 1. 围栏 ```python ... ``` 或 ``` ... ```
  const fence = text.match(/```(?:python)?\s*\n?([\s\S]*?)```/i);
  if (fence && fence[1].trim()) return fence[1].trim();
  // 2. 从 def <entry_point> 到末尾
  const defIdx = text.indexOf(`def ${entryPoint}`);
  if (defIdx >= 0) return text.slice(defIdx).trim();
  // 3. 整个输出
  return text;
}
