import { describe, expect, it } from "vitest";
import { splitText } from "./split-text.js";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("splitText", () => {
  it("splits a 9000 character reply with paragraphs into three parts under the limit", () => {
    const paragraph = `${"x".repeat(998)}\n\n`;
    const reply = paragraph.repeat(9);

    const parts = splitText(reply, { maxLength: 4096 });

    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.length <= 4096)).toBe(true);
  });

  it("closes a fence at the break and reopens it with its info string", () => {
    const code = Array.from({ length: 10 }, () => "const value = 12345;").join("\n");
    const reply = `\`\`\`ts\n${code}\n\`\`\``;

    const parts = splitText(reply, { maxLength: 100 });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 100)).toBe(true);
    expect(parts[0]?.endsWith("\n```")).toBe(true);
    expect(parts.slice(1).every((part) => part.startsWith("```ts\n"))).toBe(true);
    const restored = parts
      .map((part, i) => {
        const opened = i > 0 ? part.slice("```ts\n".length) : part;
        return i < parts.length - 1 ? opened.slice(0, -"```".length) : opened;
      })
      .join("");
    expect(restored).toBe(reply);
  });

  it("does not break inside a fence that fits in the next part", () => {
    const prose = `${"p".repeat(60)}\n\n`;
    const fence = `\`\`\`\n${"c".repeat(50)}\n\`\`\``;

    const parts = splitText(prose + fence, { maxLength: 100 });

    expect(parts).toEqual([prose, fence]);
  });

  it("hard-splits a single 5000 character word", () => {
    const word = "x".repeat(5000);

    const parts = splitText(word, { maxLength: 4096 });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length > 0 && part.length <= 4096)).toBe(true);
    expect(parts.join("")).toBe(word);
  });

  it("does not cut an emoji in half at the boundary", () => {
    const text = `${"a".repeat(9)}😀${"b".repeat(20)}`;

    const parts = splitText(text, { maxLength: 10 });

    expect(parts[0]).toBe("a".repeat(9));
    expect(parts.some((part) => LONE_SURROGATE.test(part))).toBe(false);
    expect(parts.join("")).toBe(text);
  });

  it("reproduces the input when joined and there is no fence", () => {
    const text = "One sentence here. Another one follows!\nA new line.\n\nA new paragraph? Yes. ".repeat(20);

    const parts = splitText(text, { maxLength: 120 });

    expect(parts.join("")).toBe(text);
  });

  it("returns text under the limit as one unchanged part", () => {
    const text = "  short text with edge whitespace \n";

    expect(splitText(text, { maxLength: 100 })).toEqual([text]);
  });

  it("breaks earlier to avoid a trailing part shorter than minLength", () => {
    const text = Array.from({ length: 11 }, () => "word12345").join(" ");

    const parts = splitText(text, { maxLength: 100, minLength: 25 });

    expect(parts.join("")).toBe(text);
    expect(parts.at(-1)?.length).toBeGreaterThanOrEqual(25);
  });

  it("breaks at the last boundary that fits, not the first", () => {
    const parts = splitText("aaaa bbbb cccc dddd", { maxLength: 15, minLength: 1 });

    expect(parts).toEqual(["aaaa bbbb cccc ", "dddd"]);
  });

  it("honours the prefer order over a later boundary of another kind", () => {
    const text = `${"a".repeat(30)}\n\n${"b".repeat(10)} ${"c".repeat(10)}`;

    const parts = splitText(text, { maxLength: 45, minLength: 1 });

    expect(parts[0]).toBe(`${"a".repeat(30)}\n\n`);
  });

  it("throws a RangeError for a maxLength of zero", () => {
    expect(() => splitText("abc", { maxLength: 0 })).toThrow(RangeError);
  });

  it("throws a RangeError for a fractional maxLength", () => {
    expect(() => splitText("abc", { maxLength: 2.5 })).toThrow(RangeError);
  });

  it("throws a RangeError when maxLength cannot hold the fence lines plus one character", () => {
    const reply = `\`\`\`ts\n${"x".repeat(30)}\n\`\`\``;

    expect(() => splitText(reply, { maxLength: 6 })).toThrow(RangeError);
  });

  it("keeps a four backtick fence holding a three backtick block whole or reopens the outer fence", () => {
    const filler = "filler filler filler\n".repeat(8);
    const reply = `\`\`\`\`md\n\`\`\`js\nx\n\`\`\`\n${filler}\`\`\`\`\nend`;

    const parts = splitText(reply, { maxLength: 70 });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 70)).toBe(true);
    expect(parts.slice(0, -1).every((part) => part.endsWith("````"))).toBe(true);
    expect(parts.slice(1, -1).every((part) => part.startsWith("````md\n"))).toBe(true);
    expect(parts.slice(0, -1).some((part) => part.includes("````md\n```js"))).toBe(true);
  });

  it("closes and reopens a tilde fence that spans a break with tildes", () => {
    const reply = `~~~py\n${"print(1)\n".repeat(20)}~~~`;

    const parts = splitText(reply, { maxLength: 80 });

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(0, -1).every((part) => part.endsWith("\n~~~"))).toBe(true);
    expect(parts.slice(1).every((part) => part.startsWith("~~~py\n"))).toBe(true);
    expect(parts.some((part) => part.includes("```"))).toBe(false);
  });

  it("does not close a fence on a shorter run or the other character inside it", () => {
    const filler = "filler filler filler\n".repeat(8);
    const reply = `\`\`\`\`\nshort\n\`\`\`\n~~~~\n${filler}\`\`\`\`\nend`;

    const parts = splitText(reply, { maxLength: 60 });

    expect(parts.slice(0, -1).every((part) => part.endsWith("````"))).toBe(true);
    expect(parts.slice(1, -1).every((part) => part.startsWith("````\n"))).toBe(true);
  });

  it("gives no parts for empty text", () => {
    expect(splitText("", { maxLength: 10 })).toEqual([]);
  });

  it("throws a RangeError when maxLength is too small for a surrogate pair", () => {
    expect(() => splitText("😀", { maxLength: 1 })).toThrow(RangeError);
  });

  it("does not read inline backticks after a mid-line break as a fence", () => {
    const input = "b``` ```    ```\n    ```\nxxxxxxx. ";

    const parts = splitText(input, { maxLength: 15 });

    expect(parts.join("")).toBe(input);
    expect(parts.some((part) => part.includes("\n```") && part.startsWith("```"))).toBe(false);
  });

  it("still recognises a real fence on the line after a mid-line break", () => {
    const reply = `${"w".repeat(60)}\n\`\`\`ts\n${"code();\n".repeat(10)}\`\`\``;

    const parts = splitText(reply, { maxLength: 40 });

    expect(parts[0]).toBe("w".repeat(parts[0]?.length ?? 0));
    expect(parts.some((part) => part.startsWith("```ts\n"))).toBe(true);
    expect(parts.filter((part) => part.includes("```ts")).slice(0, -1).every((part) => part.endsWith("```"))).toBe(true);
  });
});
