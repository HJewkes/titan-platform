import { describe, expect, it } from "vitest";
import { scanBlocks, type Block } from "./scan.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readBack(source: string, block: Block): string {
  return decoder.decode(encoder.encode(source).subarray(block.start, block.end));
}

function kinds(source: string): string[] {
  return scanBlocks(source).map((block) => block.kind);
}

describe("scanBlocks block kinds", () => {
  it("returns frontmatter, heading, paragraph, fence and table blocks in order", () => {
    const source = [
      "---",
      "title: Sample",
      "---",
      "# Intro",
      "",
      "First line of prose",
      "second line of prose.",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "| a | b |",
      "| - | - |",
      "",
    ].join("\n");

    expect(kinds(source)).toEqual(["frontmatter", "heading", "paragraph", "fence", "table"]);
  });

  it("gives each block byte and 1-based inclusive line ranges that read back exactly", () => {
    const source = "# Title\n\nalpha\nbeta\n\n| x |\n";

    const [heading, paragraph, table] = scanBlocks(source);

    expect(heading).toMatchObject({ kind: "heading", start: 0, end: 8, startLine: 1, endLine: 1 });
    expect(paragraph).toMatchObject({ kind: "paragraph", startLine: 3, endLine: 4 });
    expect(readBack(source, paragraph!)).toBe("alpha\nbeta\n");
    expect(table).toMatchObject({ kind: "table", startLine: 6, endLine: 6 });
    expect(readBack(source, table!)).toBe("| x |\n");
  });

  it("reports heading level and text without the marker or a closing sequence", () => {
    const [first, second] = scanBlocks("### Deep part ##\n######\n");

    expect(first).toMatchObject({ kind: "heading", level: 3, text: "Deep part" });
    expect(second).toMatchObject({ kind: "heading", level: 6, text: "" });
  });

  it("does not read seven hashes, a missing space or a 4-space indent as a heading", () => {
    expect(kinds("####### seven\n")).toEqual(["paragraph"]);
    expect(kinds("#tag\n")).toEqual(["paragraph"]);
    expect(kinds("    # indented\n")).toEqual(["paragraph"]);
  });

  it("ends a paragraph where a heading, fence or table starts", () => {
    expect(kinds("prose\n# Next\nmore\n```\ncode\n```\nafter\n| t |\n")).toEqual([
      "paragraph",
      "heading",
      "paragraph",
      "fence",
      "paragraph",
      "table",
    ]);
  });

  it("returns no blocks for empty or blank input", () => {
    expect(scanBlocks("")).toEqual([]);
    expect(scanBlocks("\n  \n\n")).toEqual([]);
  });
});

describe("scanBlocks fences", () => {
  it("does not treat a # comment inside a fence as a heading", () => {
    const source = "## Setup\n\n```sh\n# install deps\nnpm ci\n```\n";

    const blocks = scanBlocks(source);

    expect(blocks.map((block) => block.kind)).toEqual(["heading", "fence"]);
    expect(readBack(source, blocks[1]!)).toBe("```sh\n# install deps\nnpm ci\n```\n");
  });

  it("closes a tilde fence only with tildes", () => {
    const source = "~~~\n# not a heading\n```\n~~~\nafter\n";

    const blocks = scanBlocks(source);

    expect(blocks.map((block) => block.kind)).toEqual(["fence", "paragraph"]);
    expect(blocks[0]).toMatchObject({ startLine: 1, endLine: 4, closed: true });
  });

  it("keeps a 4-backtick fence open across an inner 3-backtick fence", () => {
    const source = "````md\n```js\n# inner\n```\n````\ntail\n";

    const blocks = scanBlocks(source);

    expect(blocks.map((block) => block.kind)).toEqual(["fence", "paragraph"]);
    expect(blocks[0]).toMatchObject({ startLine: 1, endLine: 5, closed: true });
  });

  it("does not close on a run followed by text", () => {
    const blocks = scanBlocks("```\n``` not a closer\n```\n");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "fence", endLine: 3, closed: true });
  });

  it("runs an unclosed fence to the end of the document", () => {
    const source = "intro\n\n```py\n# still code\n\n| not a table |\n";

    const blocks = scanBlocks(source);

    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "fence"]);
    expect(blocks[1]).toMatchObject({ startLine: 3, endLine: 6, closed: false });
    expect(blocks[1]!.end).toBe(encoder.encode(source).length);
  });

  it("does not open a backtick fence whose info string holds a backtick", () => {
    expect(kinds("``` a`b\n# Heading\n")).toEqual(["paragraph", "heading"]);
  });
});

describe("scanBlocks frontmatter", () => {
  it("accepts ... as the closing line", () => {
    const source = "---\nkey: v\n...\nbody\n";

    const [frontmatter] = scanBlocks(source);

    expect(frontmatter).toMatchObject({ kind: "frontmatter", startLine: 1, endLine: 3 });
    expect(readBack(source, frontmatter!)).toBe("---\nkey: v\n...\n");
  });

  it("is not frontmatter when unclosed or not on the first line", () => {
    expect(kinds("---\nkey: v\n")).not.toContain("frontmatter");
    expect(kinds("text\n---\nkey: v\n---\n")).not.toContain("frontmatter");
  });
});

describe("scanBlocks byte offsets", () => {
  it("keeps exact byte offsets for CRLF line endings", () => {
    const source = "# Title\r\n\r\nbody one\r\nbody two\r\n\r\n```\r\n# x\r\n```\r\n";

    const blocks = scanBlocks(source);

    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "fence"]);
    expect(blocks[0]).toMatchObject({ start: 0, end: 9, text: "Title" });
    expect(blocks[1]).toMatchObject({ start: 11, end: 31, startLine: 3, endLine: 4 });
    expect(readBack(source, blocks[1]!)).toBe("body one\r\nbody two\r\n");
    expect(readBack(source, blocks[2]!)).toBe("```\r\n# x\r\n```\r\n");
  });

  it("counts multi-byte characters as UTF-8 bytes", () => {
    const source = "# Café ✓\n\nnaïve 😀\n";

    const [heading, paragraph] = scanBlocks(source);

    expect(heading).toMatchObject({ start: 0, end: 12, text: "Café ✓" });
    expect(paragraph).toMatchObject({ start: 13, end: 25 });
    expect(readBack(source, paragraph!)).toBe("naïve 😀\n");
  });

  it("gives the same blocks for a string and its UTF-8 bytes", () => {
    const source = "# A\n\nb ✓\n";

    expect(scanBlocks(encoder.encode(source))).toEqual(scanBlocks(source));
  });

  it("ends the last block at the byte length when there is no final newline", () => {
    const source = "para";

    expect(scanBlocks(source)).toEqual([
      { kind: "paragraph", start: 0, end: 4, startLine: 1, endLine: 1 },
    ]);
  });
});
