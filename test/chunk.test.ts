import { describe, expect, it } from "vitest";
import { chunkMarkdown, MARKDOWN_BLOCK_LIMIT, plainFallback } from "../src/chunk";

describe("chunkMarkdown", () => {
  it("returns short text as one chunk", () => {
    expect(chunkMarkdown("hello **world**")).toEqual(["hello **world**"]);
  });

  it("returns nothing for empty text", () => {
    expect(chunkMarkdown("   \n ")).toEqual([]);
  });

  it("keeps every chunk under the limit and loses no text", () => {
    const paragraphs = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: ` + "lorem ipsum ".repeat(20));
    const text = paragraphs.join("\n\n");
    const chunks = chunkMarkdown(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(chunks.join("\n\n").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("uses the default size under Slack's 12,000 character block limit", () => {
    const chunks = chunkMarkdown("x ".repeat(30_000));
    for (const c of chunks) expect(c.length).toBeLessThan(MARKDOWN_BLOCK_LIMIT);
  });

  it("re-checks the limit after breaking at a blank line", () => {
    const max = 1000;
    const text = [...Array(20).fill("short"), "", "x".repeat(500), "y".repeat(600)].join("\n");
    const chunks = chunkMarkdown(text, max);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(max);
    expect(chunks.join("\n").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("hard-splits a single very long line", () => {
    const chunks = chunkMarkdown("a".repeat(5000), 1000);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.join("")).toBe("a".repeat(5000));
  });

  it("closes and reopens code fences across chunks", () => {
    const code = Array.from({ length: 100 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const text = "Intro\n\n```ts\n" + code + "\n```\n\nOutro";
    const chunks = chunkMarkdown(text, 600);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(600);
      const fences = c.split("\n").filter((l) => l.trim().startsWith("```")).length;
      expect(fences % 2).toBe(0);
    }
    expect(chunks[1]!.startsWith("```ts")).toBe(true);
  });
});

describe("plainFallback", () => {
  it("flattens whitespace and truncates", () => {
    expect(plainFallback("a\n\nb   c")).toBe("a b c");
    expect(plainFallback("x".repeat(5000), 100)).toHaveLength(100);
  });
});
