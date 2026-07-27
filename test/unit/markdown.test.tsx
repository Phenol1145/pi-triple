import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Markdown } from "../../src/tui/components/markdown.js";

describe("Markdown component", () => {
  it("renders plain text", () => {
    const { lastFrame } = render(<Markdown content="hello world" />);
    expect(lastFrame()).toContain("hello world");
  });

  it("renders bold text", () => {
    const { lastFrame } = render(<Markdown content="**bold**" />);
    expect(lastFrame()).toContain("bold");
  });

  it("renders inline code", () => {
    const { lastFrame } = render(<Markdown content="use `foo()` here" />);
    expect(lastFrame()).toContain("foo()");
  });

  it("renders code block", () => {
    const { lastFrame } = render(<Markdown content="```python\nprint('hi')\n```" />);
    expect(lastFrame()).toContain("print");
    expect(lastFrame()).toContain("python");
  });

  it("renders list items", () => {
    const { lastFrame } = render(<Markdown content="- item1\n- item2" />);
    expect(lastFrame()).toContain("item1");
    expect(lastFrame()).toContain("item2");
    expect(lastFrame()).toContain("•");
  });

  it("renders heading", () => {
    const { lastFrame } = render(<Markdown content="# Title" />);
    expect(lastFrame()).toContain("Title");
  });

  it("handles empty string", () => {
    const { lastFrame } = render(<Markdown content="" />);
    expect(lastFrame()).toBe("");
  });
});
