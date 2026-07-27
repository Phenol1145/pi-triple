/**
 * Markdown → ANSI terminal text renderer.
 * Uses marked.lexer() for tokenization + cli-highlight for code blocks.
 * This is a pure utility function, not a React component.
 */
import { marked } from "marked";
import { highlight } from "cli-highlight";
import type { Token, Tokens } from "marked";

// Convenience type alias for inline token arrays
type InlineToken = Token;

/**
 * Render Markdown string to ANSI-styled terminal text.
 * Code blocks are syntax-highlighted via cli-highlight.
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";

  const tokens = marked.lexer(text);
  return renderTokens(tokens);
}

function renderTokens(tokens: Token[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        out += renderHeading(token as Tokens.Heading);
        break;
      case "paragraph":
        out += renderInline((token as Tokens.Paragraph).tokens) + "\n";
        break;
      case "code":
        out += renderCodeBlock((token as Tokens.Code).text, (token as Tokens.Code).lang) + "\n";
        break;
      case "list":
        out += renderList(token as Tokens.List);
        break;
      case "blockquote":
        out += renderBlockquote(token as Tokens.Blockquote);
        break;
      case "hr":
        out += "─".repeat(40) + "\n";
        break;
      case "space":
        out += "\n";
        break;
      case "html": {
        const html = token as Tokens.HTML;
        if (!html.block) {
          out += `\x1b[90m${html.text}\x1b[0m\n`;
        }
        break;
      }
      case "table": {
        // Fallback: render table as preformatted text
        out += `\x1b[90m${(token as Tokens.Table).raw}\x1b[0m\n`;
        break;
      }
      case "text":
        // Top-level text (unusual, but handle)
        out += (token as Tokens.Text).text + "\n";
        break;
      default:
        // Unknown / Generic tokens: render raw text if available
        if ("raw" in token && typeof token.raw === "string") {
          out += token.raw + "\n";
        }
        break;
    }
  }
  return out.trimEnd();
}

function renderHeading(token: Tokens.Heading): string {
  const prefix = "#".repeat(token.depth);
  const body = renderInline(token.tokens);
  return `\x1b[1m${prefix} ${body}\x1b[0m\n`;
}

function renderCodeBlock(code: string, lang?: string): string {
  let highlighted: string;
  try {
    highlighted = highlight(code, { language: lang, ignoreIllegals: true });
  } catch {
    highlighted = code;
  }

  const border = "\x1b[90m";
  const lines = highlighted.split("\n");
  const header = lang
    ? `${border}┌─ ${lang} ${"─".repeat(Math.max(0, 30 - lang.length))}┐\x1b[0m`
    : `${border}┌${"─".repeat(34)}┐\x1b[0m`;
  const footer = `${border}└${"─".repeat(34)}┘\x1b[0m`;
  const body = lines.map((l) => `${border}│\x1b[0m ${l}`).join("\n");
  return `${header}\n${body}\n${footer}`;
}

function renderList(token: Tokens.List): string {
  let out = "";
  for (const item of token.items) {
    const marker = token.ordered ? "  " : "  •";
    const body = renderInline(item.tokens);
    out += `${marker} ${body}\n`;
  }
  return out;
}

function renderBlockquote(token: Tokens.Blockquote): string {
  const body = renderInline(token.tokens);
  return `  \x1b[2m│ ${body}\x1b[0m\n`;
}

/**
 * Render inline token array (bold, italic, code, links, plain text).
 */
function renderInline(tokens: InlineToken[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out += `\x1b[1m${renderInline((token as Tokens.Strong).tokens)}\x1b[0m`;
        break;
      case "em":
        out += `\x1b[3m${renderInline((token as Tokens.Em).tokens)}\x1b[0m`;
        break;
      case "del":
        out += `\x1b[9m${renderInline((token as Tokens.Del).tokens)}\x1b[0m`;
        break;
      case "codespan":
        out += `\x1b[36m${(token as Tokens.Codespan).text}\x1b[0m`;
        break;
      case "link": {
        const link = token as Tokens.Link;
        out += `\x1b[34m${renderInline(link.tokens)}\x1b[0m`;
        break;
      }
      case "image": {
        const img = token as Tokens.Image;
        out += `\x1b[34m[img: ${img.text}]\x1b[0m`;
        break;
      }
      case "text":
        out += (token as Tokens.Text).text;
        break;
      case "escape":
        out += (token as Tokens.Escape).text;
        break;
      case "br":
        out += "\n";
        break;
      case "html": {
        const html = token as Tokens.HTML;
        if (!html.block) {
          out += `\x1b[90m${html.text}\x1b[0m`;
        }
        break;
      }
      default:
        // Generic / unknown inline token
        if ("text" in token && typeof token.text === "string") {
          out += token.text;
        }
        break;
    }
  }
  return out;
}
