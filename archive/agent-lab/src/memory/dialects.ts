/**
 * Dialect Adapters for Memory System
 * 纯解析模块（无依赖）
 * 
 * 确定性提取器：正则/结构化解析，非 LLM 解析
 * 置信度：json/xml = high；markdown = medium
 */

export type DialectId = "json" | "xml" | "markdown";
export type Confidence = "high" | "medium";

export interface DialectResult {
  ok: boolean;
  fields: Record<string, unknown>;
  confidence: Confidence;
  source?: "partial";
  errors: string[];
}

/**
 * Parse dialect content and extract fields
 * @param dialect - The dialect type to parse (json, xml, markdown)
 * @param text - The text content to parse
 * @returns DialectResult with extracted fields and metadata
 */
export function parseDialect(dialect: DialectId, text: string): DialectResult {
  const result: DialectResult = {
    ok: false,
    fields: {},
    confidence: dialect === "markdown" ? "medium" : "high",
    errors: []
  };

  try {
    if (dialect === "json") {
      return parseJson(text, result);
    } else if (dialect === "xml") {
      return parseXml(text, result);
    } else if (dialect === "markdown") {
      return parseMarkdown(text, result);
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }

  return result;
}

// ===== JSON Parser =====
function parseJson(text: string, result: DialectResult): DialectResult {
  let jsonText = text;
  
  // Check for fenced code block ```json ... ```
  const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fencedMatch) {
    jsonText = fencedMatch[1];
  } else {
    // Try to find any fenced block
    const anyFencedMatch = text.match(/```\w*\s*([\s\S]*?)\s*```/);
    if (anyFencedMatch) {
      jsonText = anyFencedMatch[1];
    }
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      result.ok = true;
      result.fields = parsed as Record<string, unknown>;
    } else {
      result.errors.push("JSON content is not an object");
      result.ok = false;
    }
  } catch (e) {
    result.errors.push(`JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
    result.ok = false;
  }

  return result;
}

// ===== XML Parser =====
function parseXml(text: string, result: DialectResult): DialectResult {
  // Simple XML tag extraction: <tag>value</tag>
  // Find all field tags within the root element (e.g., <fact>)
  const tagPattern = /<([^/>\s][^>]*)>([^<]*)<\/\1>/g;
  const fields: Record<string, unknown> = {};
  let hasContent = false;

  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const tagName = match[1];
    const value = match[2].trim();
    // Skip root element tags like "fact"
    if (!value) continue;
    fields[tagName] = value;
    hasContent = true;
  }

  if (hasContent && Object.keys(fields).length > 0) {
    result.ok = true;
    result.fields = fields;
  } else {
    result.errors.push("No valid XML fields extracted");
    result.ok = false;
  }

  return result;
}

// ===== Markdown Parser =====
function parseMarkdown(text: string, result: DialectResult): DialectResult {
  // Pattern: ## key\nvalue
  const pattern = /^##\s+([^\n]+)\n([^\n]+)/gm;
  const fields: Record<string, unknown> = {};
  let hasContent = false;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const key = match[1].trim();
    const value = match[2].trim();
    fields[key] = value;
    hasContent = true;
  }

  if (hasContent) {
    result.ok = true;
    result.fields = fields;
    result.confidence = "medium";
  } else {
    result.errors.push("No valid markdown fields extracted");
    result.ok = false;
  }

  return result;
}