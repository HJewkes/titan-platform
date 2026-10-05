import { describe, expect, it } from "vitest";
import { extractCommands } from "./commands.js";
import { pipedShellTexts } from "./piped-nul.js";

const gitArgs = (src: string) =>
  extractCommands(src, { cwd: "/home/you/app", home: "/home/you" })
    .filter((c) => c.name === "git")
    .map((c) => c.args.map((a) => a.value));

const pushed = ["push", "origin", "HEAD:main"];

describe("NUL in text piped into zsh", () => {
  it.each([
    ["printf", "printf 'git\\0xyz push origin HEAD:main\\n' | zsh"],
    ["printf octal", "printf 'git\\000xyz push origin HEAD:main\\n' | zsh"],
    ["printf %b", "printf '%b' 'git\\0xyz push origin HEAD:main' | zsh"],
    ["echo -e", "echo -e 'git\\0xyz push origin HEAD:main' | zsh"],
  ])("cuts the word at NUL: %s", (_how, src) => {
    expect(gitArgs(src).at(-1)).toEqual(pushed);
  });

  it.each([
    ["after a word cut by NUL", "printf 'echo x\\0y;git push origin HEAD:main\\n' | zsh"],
    ["after a NUL and &&", "printf 'true\\0&&git push origin HEAD:main\\n' | zsh"],
    ["after a quoted NUL word", "printf \"echo 'a\\0b' ; git push origin HEAD:main\\n\" | zsh"],
  ])("still sees a push %s", (_how, src) => {
    expect(gitArgs(src)).toContainEqual(pushed);
  });

  it("leaves the push unseen when bash reads the same text", () => {
    expect(gitArgs("printf 'git\\0xyz push origin HEAD:main\\n' | bash")).toEqual([]);
  });

  it("keeps the dropped reading for bash, sh and dash", () => {
    for (const shell of ["bash", "sh", "dash"]) {
      expect(gitArgs(`printf 'git pu\\0sh origin HEAD:main\\n' | ${shell}`).at(-1)).toEqual(pushed);
    }
  });

  it("reads a ksh pipe both ways", () => {
    expect(gitArgs("printf 'git\\0xyz push origin HEAD:main\\n' | ksh")).toContainEqual(pushed);
    expect(gitArgs("printf 'git pu\\0sh origin HEAD:main\\n' | ksh")).toContainEqual(pushed);
  });
});

describe("pipedShellTexts", () => {
  it("returns text without NUL unchanged for every shell", () => {
    expect(pipedShellTexts("zsh", "git status\n")).toEqual(["git status\n"]);
  });

  it("reads zsh both ways, cutting each word at NUL but not past an operator or quote", () => {
    expect(pipedShellTexts("zsh", "a\0b c\0d\0e\tf\0g\nh")).toEqual(["ab cde\tfg\nh", "a c\tf\nh"]);
    expect(pipedShellTexts("zsh", "x\0y;z 'a\0b' q")).toEqual(["xy;z 'ab' q", "x;z 'a' q"]);
  });

  it("drops NUL for bash", () => {
    expect(pipedShellTexts("bash", "a\0b c")).toEqual(["ab c"]);
  });

  it("returns one reading for ksh when both agree", () => {
    expect(pipedShellTexts("ksh", "a\0 b")).toEqual(["a b"]);
  });
});
