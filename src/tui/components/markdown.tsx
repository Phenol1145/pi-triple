/**
 * Markdown → Ink React elements renderer.
 * Uses marked.lexer() for tokenization, renders via Ink <Text> styling
 * (bold, italic, color) instead of raw ANSI escape codes.
 */
import React from "react";
import { Box, Text } from "ink";
import { marked } from "marked";
import type { Token, Tokens } from "marked";

interface MarkdownProps {
  content: string;
}

/** Render Markdown as Ink React elements */
export function Markdown({ content }: MarkdownProps): React.ReactNode {
  if (!content) return null;
  const tokens = marked.lexer(content);
  return <Box flexDirection="column">{renderBlockTokens(tokens)}</Box>;
}

// ─── Block-level tokens ──────────────────────────────────────

function renderBlockTokens(tokens: Token[]): React.ReactNode[] {
  const els: React.ReactNode[] = [];
  let key = 0;

  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const t = token as Tokens.Heading;
        els.push(
          <Text key={key++} bold>
            {"#".repeat(t.depth)} {renderInlineTokens(t.tokens)}
          </Text>,
        );
        break;
      }
      case "paragraph": {
        const t = token as Tokens.Paragraph;
        els.push(<Text key={key++}>{renderInlineTokens(t.tokens)}</Text>);
        break;
      }
      case "code": {
        const t = token as Tokens.Code;
        els.push(renderCodeBlock(t.text, key++, t.lang));
        break;
      }
      case "list": {
        const t = token as Tokens.List;
        for (const item of t.items) {
          els.push(
            <Box key={key++}>
              <Text>{t.ordered ? "  " : "  • "}</Text>
              <Text>{renderInlineTokens(item.tokens)}</Text>
            </Box>,
          );
        }
        break;
      }
      case "blockquote": {
        const t = token as Tokens.Blockquote;
        els.push(
          <Box key={key++} marginLeft={2}>
            <Text dimColor>│ </Text>
            <Text dimColor>{renderBlockTokens(t.tokens)}</Text>
          </Box>,
        );
        break;
      }
      case "hr":
        els.push(
          <Text key={key++} dimColor>
            {"─".repeat(40)}
          </Text>,
        );
        break;
      case "space":
        break;
      case "table": {
        const t = token as Tokens.Table;
        els.push(
          <Text key={key++} dimColor>
            {t.raw}
          </Text>,
        );
        break;
      }
      case "text": {
        const t = token as Tokens.Text;
        if ("tokens" in t && Array.isArray(t.tokens) && t.tokens.length > 0) {
          els.push(<Text key={key++}>{renderInlineTokens(t.tokens)}</Text>);
        } else {
          els.push(<Text key={key++}>{t.text}</Text>);
        }
        break;
      }
      default:
        if ("raw" in token && typeof token.raw === "string") {
          els.push(<Text key={key++}>{token.raw}</Text>);
        }
        break;
    }
  }
  return els;
}

// ─── Inline tokens ───────────────────────────────────────────

function renderInlineTokens(tokens: Token[]): React.ReactNode[] {
  const els: React.ReactNode[] = [];
  let key = 0;

  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        els.push(
          <Text key={key++} bold>
            {renderInlineTokens((token as Tokens.Strong).tokens)}
          </Text>,
        );
        break;
      case "em":
        els.push(
          <Text key={key++} italic>
            {renderInlineTokens((token as Tokens.Em).tokens)}
          </Text>,
        );
        break;
      case "del":
        els.push(
          <Text key={key++} strikethrough>
            {renderInlineTokens((token as Tokens.Del).tokens)}
          </Text>,
        );
        break;
      case "codespan":
        els.push(
          <Text key={key++} color="cyan">
            {(token as Tokens.Codespan).text}
          </Text>,
        );
        break;
      case "link": {
        const t = token as Tokens.Link;
        els.push(
          <Text key={key++} color="blue" underline>
            {renderInlineTokens(t.tokens)}
          </Text>,
        );
        break;
      }
      case "image": {
        const t = token as Tokens.Image;
        els.push(
          <Text key={key++} color="blue">
            [img: {t.text}]
          </Text>,
        );
        break;
      }
      case "text": {
        const t = token as Tokens.Text;
        if ("tokens" in t && Array.isArray(t.tokens) && t.tokens.length > 0) {
          els.push(...renderInlineTokens(t.tokens).map((el, i) =>
            React.isValidElement(el)
              ? React.cloneElement(el, { key: `${key}-${i}` } as any)
              : el,
          ));
          key++;
        } else {
          els.push(<Text key={key++}>{t.text}</Text>);
        }
        break;
      }
      case "escape":
        els.push(<Text key={key++}>{(token as Tokens.Escape).text}</Text>);
        break;
      case "br":
        els.push(<Text key={key++}>{"\n"}</Text>);
        break;
      default:
        if ("text" in token && typeof token.text === "string") {
          els.push(<Text key={key++}>{token.text}</Text>);
        }
        break;
    }
  }
  return els;
}

// ─── Code block ──────────────────────────────────────────────

function renderCodeBlock(
  code: string,
  key: number,
  lang?: string,
): React.ReactNode {
  const lines = code.split("\n");
  return (
    <Box key={key} flexDirection="column" marginBottom={1}>
      <Text dimColor>{lang ? `┌─ ${lang} ` : "┌"}{"─".repeat(Math.max(0, 30 - (lang?.length ?? 0)))}</Text>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text dimColor>│ </Text>
          <Text color="green">{line}</Text>
        </Box>
      ))}
      <Text dimColor>└{"─".repeat(30)}</Text>
    </Box>
  );
}

// ─── Legacy export for test compatibility ────────────────────

/** @deprecated Use <Markdown> component instead */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  return text;
}
