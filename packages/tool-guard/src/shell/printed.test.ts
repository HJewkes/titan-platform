import { describe, expect, it } from "vitest";
import { extractCommands } from "./commands.js";
import { printedReadings, printedText } from "./printed.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";

const words = (args: string[]) => tokenize(args.join(" ")).filter((t): t is WordToken => "value" in t && "dynamic" in t);
const printed = (name: string, ...args: string[]) => printedText(name, words(args));

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

  it.each([
    ["printf %b", "printf '%b' '\\147it push origin HEAD:main' | bash"],
  ])("reads \\nnn as octal too: %s", (_how, src) => {
    expect(gitArgs(src).at(-1)).toEqual(["push", "origin", "HEAD:main"]);
  });

  it("stops all printf output at a %b \\c, format remainder included", () => {
    expect(printed("printf", "'%bx'", "'git push origin HEAD:main\\c'")).toBe("git push origin HEAD:main");
    expect(gitArgs("printf '%bx' 'git push origin HEAD:main\\c' | bash").at(-1)).toEqual(["push", "origin", "HEAD:main"]);
  });

  it("drops later arguments after a \\c in a middle argument", () => {
    expect(printed("printf", "'%b %b'", "'git\\c'", "push")).toBe("git");
    expect(printed("printf", "'%s%b%s'", "'git '", "'push\\c'", "' --force'")).toBe("git push");
  });

  it("keeps quote escapes literal in echo -e", () => {
    expect(printed("echo", "-e", "'\\\"x\\?'")).toBe('\\"x\\?');
  });

  it("keeps printing after a literal U+10FFFF argument", () => {
    const text = printed("printf", "'%s\\ngit push origin HEAD:main\\n'", "$'\\U0010ffff'");
    expect(text).toBe("\u{10ffff}\ngit push origin HEAD:main\n");
    expect(printed("printf", "'%b\\ngit push'", "'\\U0010ffff'")).toBe("\u{10ffff}\ngit push");
  });

  it("does not pad a %b argument that ends at \\c", () => {
    expect(printed("printf", "'%5b'", "'a\\c'")).toBe("a");
  });
});

describe("NUL bytes in piped text", () => {
  const pushed = ["push", "origin", "HEAD:main"];
  it.each([
    ["printf octal \\000", "printf 'git pu\\000sh origin HEAD:main\\n' | bash"],
    ["printf \\0", "printf 'git pu\\0sh origin HEAD:main\\n' | bash"],
    ["printf %b", "printf '%b' 'git pu\\0sh origin HEAD:main' | sh"],
    ["echo -e", "echo -e 'git pu\\0sh origin HEAD:main' | bash"],
  ])("drops NUL as bash and sh do: %s", (_how, src) => {
    expect(gitArgs(src).at(-1)).toEqual(pushed);
  });

  it("keeps NUL for xargs -0, which splits on it", () => {
    expect(printed("printf", "'a\0b'")).toBe("a\0b");
  });
});

describe("bash and zsh builtins", () => {
  it.each([
    [["-", "a"], "- a", "a"],
    [["-n", "-", "a"], "- a", "a"],
    [["-", "-n", "a"], "- -n a", "-n a"],
    [["--", "a"], "-- a", "-- a"],
  ])("echo %j prints %j in bash and %j in zsh", (args, bash, zsh) => {
    expect(printedText("echo", words(args), "bash")).toBe(bash);
    expect(printedText("echo", words(args), "zsh")).toBe(zsh);
  });

  it("counts printf precision in bytes for bash and characters for zsh", () => {
    expect(printedText("printf", words(["'[%.4s]'", "ééégit"]), "bash")).toBe("[éé]");
    expect(printedText("printf", words(["'[%.4s]'", "ééégit"]), "zsh")).toBe("[ééég]");
  });

  it("counts printf width in bytes for bash and characters for zsh", () => {
    expect(printedText("printf", words(["'[%6s]'", "é"]), "bash")).toBe("[    é]");
    expect(printedText("printf", words(["'[%6s]'", "é"]), "zsh")).toBe("[     é]");
  });
});

describe("readings under each splicing shell", () => {
  const shells = ["bash", "zsh"] as const;
  const readings = (name: string, args: string[]) => printedReadings(name, words(args), shells);

  it("keeps echo's lone '-' for no shell and bash, and drops it for zsh", () => {
    expect(readings("echo", ["-", "git", "push"])).toEqual(["- git push", "git push"]);
  });

  it("gives one text when every shell prints the same", () => {
    expect(readings("echo", ["git", "push"])).toEqual(["git push"]);
  });

  it("gives printf's character and byte precision texts", () => {
    expect(readings("printf", ["'[%.4s]'", "ééégit"])).toEqual(["[ééég]", "[éé]"]);
  });

  it("gives printf's character and byte width texts", () => {
    expect(readings("printf", ["'[%6s]'", "é"])).toEqual(["[     é]", "[    é]"]);
  });

  it("gives nothing for a dynamic argument", () => {
    expect(readings("echo", ["-", "$cmd"])).toEqual([]);
  });

  it("gives nothing for a command that is not a print builtin", () => {
    expect(readings("cat", ["-"])).toEqual([]);
  });
});
