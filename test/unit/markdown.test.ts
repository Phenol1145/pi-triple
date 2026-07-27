import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../src/tui/components/markdown.js";

describe("renderMarkdown", () => {
  it("renders plain text", () => {
    const out = renderMarkdown("hello world");
    expect(out).toContain("hello world");
  });

  it("renders bold", () => {
    const out = renderMarkdown("**bold**");
    expect(out).toContain("bold");
  });

  it("renders code block with language", () => {
    const out = renderMarkdown("```python\nprint('hi')\n```");
    expect(out).toContain("print");
  });

  it("renders inline code", () => {
    const out = renderMarkdown("use `foo()` here");
    expect(out).toContain("foo()");
  });

  it("handles empty string", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
