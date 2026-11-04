import { describe, expect, it } from "vitest";
import { PROMPT_LINE_BREAK, promptLine } from "./prompt-text.js";

describe("promptLine", () => {
  it.each([
    ["a C0 control", "ok\u0007\u0000ay", "okay"],
    ["DEL and a C1 control", "ok\u007f\u009bay", "okay"],
    ["a CSI escape sequence", "\u001b[2J\u001b[31mred\u001b[0m", "red"],
    ["an OSC title sequence", "\u001b]0;title\u0007body", "body"],
    ["a right-to-left override", "file\u202egnp.exe", "filegnp.exe"],
    ["the bidi embeddings and pop", "\u202aa\u202bb\u202cc\u202dd", "abcd"],
    ["the bidi isolates", "\u2066a\u2067b\u2068c\u2069", "abc"],
    ["the bidi marks", "a\u200eb\u200fc\u061cd", "abcd"],
    ["zero-width characters and a BOM", "a\u200bb\u200dc\u2060d\ufeff", "abcd"],
    ["tag characters", "ok\u{e0001}\u{e0041}\u{e0042}ay", "okay"],
    ["a soft hyphen", "ok\u00aday", "okay"],
    ["a line separator", "a\u2028b", "a b"],
    ["a paragraph separator", "a\u2029b", "a b"],
    ["NEL", "a\u0085b", "a b"],
    ["CR, LF and CRLF", "a\rb\nc\r\nd", "a b c d"],
    ["a tab", "a\tb", "a b"],
  ])("strips or flattens %s", (_name, text, shown) => {
    expect(promptLine(text)).toBe(shown);
  });

  it("puts the caller's mark where each line break was", () => {
    expect(promptLine("a\u2028b\r\nc", { lineBreak: "⏎" })).toBe("a⏎b⏎c");
  });

  it("keeps letters, punctuation and emoji outside the stripped classes", () => {
    expect(promptLine("Merge — 合并 ✅ ok?")).toBe("Merge — 合并 ✅ ok?");
  });
});

describe("PROMPT_LINE_BREAK", () => {
  it("splits at every break promptLine flattens, CRLF as one", () => {
    expect("a\r\nb\rc\nd\u0085e\u2028f\u2029g".split(PROMPT_LINE_BREAK)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
});
