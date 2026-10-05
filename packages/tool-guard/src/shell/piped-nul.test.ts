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

describe("piped zsh words cut after parsing", () => {
  it.each([
    ["a quote after the NUL", "printf 'git\\0\"x\" push origin HEAD:main\\n' | zsh", pushed],
    ["an escape after the NUL", "printf 'git\\0\\\\z push origin HEAD:main\\n' | zsh", pushed],
    ["a substitution after the NUL", "printf 'git\\0$(echo z) push origin HEAD:main\\n' | zsh", pushed],
    ["a backtick after the NUL", "printf 'git\\0`echo z` push origin HEAD:main\\n' | zsh", pushed],
    ["a quoted blank after the NUL", "printf 'git push\\0\" \"x origin HEAD:main\\n' | zsh", pushed],
  ])("sees the push with %s", (_how, src, args) => {
    expect(gitArgs(src)).toContainEqual(args);
  });

  it("cuts the word inside a nested substitution", () => {
    expect(gitArgs("printf 'echo $(git\\0x push origin HEAD:main)\\n' | zsh")).toContainEqual(pushed);
  });

  it("keeps an operator after the NUL as a separator", () => {
    expect(gitArgs("printf 'echo x\\0y;git push origin HEAD:main\\n' | zsh")).toContainEqual(pushed);
  });
});

describe("NUL kept where a zsh builtin or assignment takes the word whole", () => {
  it.each([
    ["eval text", "printf 'eval \"git\\0x push origin HEAD:main\"\\n' | zsh"],
    ["a variable read by eval", "printf 'x=\"git\\0x push origin HEAD:main\"; eval $x\\n' | zsh"],
    ["a here-string", "printf 'zsh <<< \"git\\0x push origin HEAD:main\"\\n' | zsh"],
    ["echo piped on", "printf 'echo \"git\\0x push origin HEAD:main\" | zsh\\n' | zsh"],
    ["a heredoc", "zsh <<'EOS'\ngit\0x push origin HEAD:main\nEOS"],
  ])("sees the push in %s", (_how, src) => {
    expect(gitArgs(src)).toContainEqual(pushed);
  });
});

describe("NUL that cuts a wrapper's own name", () => {
  it.each([
    ["env", "env\\0x"],
    ["/usr/bin/env", "/usr/bin/env\\0x"],
    ["command", "command\\0x"],
    ["builtin", "builtin\\0x"],
    ["exec", "exec\\0x"],
    ["nohup", "nohup\\0x"],
    ["time", "time\\0x"],
    ["nice", "nice\\0x"],
    ["sudo", "sudo\\0x"],
    ["doas", "doas\\0x"],
    ["timeout", "timeout\\0x 5"],
    ["xargs", "xargs\\0x"],
    ["stdbuf", "stdbuf\\0x -o0"],
    ["setsid", "setsid\\0x"],
    ["flock", "flock\\0x /tmp/l"],
    ["watch", "watch\\0x"],
    ["npx", "npx\\0x"],
    ["pnpm", "pnpm\\0x exec"],
  ])("unwraps %s again after the cut", (_name, wrapper) => {
    expect(gitArgs(`printf '${wrapper} git push origin HEAD:main\\n' | zsh`)).toContainEqual(pushed);
  });
});

describe("pipedShellTexts", () => {
  it("returns text without NUL unchanged for every shell", () => {
    expect(pipedShellTexts("zsh", "git status\n")).toEqual(["git status\n"]);
  });

  it("reads zsh and ksh as dropped and raw", () => {
    for (const shell of ["zsh", "ksh"]) expect(pipedShellTexts(shell, "a\0b c")).toEqual(["ab c", "a\0b c"]);
  });

  it("drops NUL for bash, sh and dash", () => {
    for (const shell of ["bash", "sh", "dash"]) expect(pipedShellTexts(shell, "a\0b c")).toEqual(["ab c"]);
  });
});
