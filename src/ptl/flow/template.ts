/**
 * pit-flow 模板插值
 *
 * 支持 {{state.x.y}}（嵌套路径）与 {{input.x}}。
 * 缺失值 → 空字符串。
 */

export function interpolate(
  text: string,
  ctx: { state: Record<string, unknown>; input: Record<string, string> },
): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, expr: string) => {
    const trimmed = expr.trim();
    if (trimmed.startsWith("input.")) {
      const key = trimmed.slice(6);
      return ctx.input[key] ?? "";
    }
    if (trimmed.startsWith("state.")) {
      const path = trimmed.slice(6).split(".");
      let val: unknown = ctx.state;
      for (const seg of path) {
        if (val === null || val === undefined || typeof val !== "object") return "";
        val = (val as Record<string, unknown>)[seg];
      }
      if (val === null || val === undefined) return "";
      return String(val);
    }
    // 不认识的占位符，原样保留
    return `{{${trimmed}}}`;
  });
}
