import { describe, expect, it } from "vitest";
import { extractCommands } from "./commands.js";
import { printedText } from "./printed.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";

const printed = (name: string, ...args: string[]) =>
  printedText(name, tokenize(args.join(" ")).filter((t): t is WordToken => "value" in t && "dynamic" in t));

const gitArgs = (src: string) =>
  extractCommands(src, { cwd: "/home/you/app", home: "/home/you" })
    .filter((c) => c.name === "git")
    .map((c) => c.args.map((a) => a.value));

describe("octal in echo and printf %b", () => {
  it.each([
    ["echo -e", "echo -e '\\0147it push origin HEAD:main' | sh"],
    ["printf %b", "printf '%b' '\\0147it push origin HEAD:main' | sh"],
  ])("reads \\0nnn as octal: %s", (_how, src) => {
    expect(gitArgs(src).at(-1)).toEqual(["push", "origin", "HEAD:main"]);
  });

  it("keeps the \\nnn rule in a printf format string", () => {
    expect(printed("printf", "'\\0147'")).toBe("\f7");
    expect(printed("printf", "'\\147'")).toBe("g");
  });

  it("ends echo output at \\c", () => {
    expect(printed("echo", "-e", "'git\\c push'")).toBe("git");
  });

  it("leaves \\nnn without a leading 0 undecoded in echo", () => {
    expect(printed("echo", "-e", "'\\147'")).toBe("\\147");
  });
});
