import { describe, expect, it } from "vitest";
import { stripMarkdownForPreview } from "./history.service";

describe("stripMarkdownForPreview", () => {
  it("unwraps bold heading syntax instead of showing literal asterisks", () => {
    expect(stripMarkdownForPreview("**💡 Prerequisites Check**\n\nBody text.")).toBe("💡 Prerequisites Check Body text.");
  });

  it("drops fenced code/canvas blocks entirely", () => {
    const input = "Some text\n```html\n<svg></svg>\n```\nMore text";
    expect(stripMarkdownForPreview(input)).toBe("Some text More text");
  });

  it("collapses KaTeX delimiters", () => {
    expect(stripMarkdownForPreview("The formula $v = d/t$ shows this.")).toBe("The formula v = d/t shows this.");
  });

  it("collapses runs of whitespace/newlines into single spaces", () => {
    expect(stripMarkdownForPreview("line one\n\n\nline two")).toBe("line one line two");
  });
});
