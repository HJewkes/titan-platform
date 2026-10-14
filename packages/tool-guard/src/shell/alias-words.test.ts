import { describe, expect, it } from "vitest";
import { extractCommands, type SimpleCommand } from "./commands.js";
import { ParseError } from "./lexer.js";
import type { AliasTable } from "./alias-words.js";

const ALIASES: AliasTable = new Map([
  ["g", ["git"]],
  ["gp", ["g push"]],
  ["git", ["git --no-pager"]],
  ["x", ["cd /r && git push"]],
  ["cp", ["nocorrect cp"]],
  ["bad", ['echo "']],
  ["s", ["sudo"]],
]);

function lines(src: string, aliases: AliasTable | null = ALIASES): string[] {
  return extractCommands(src, aliases ? { cwd: "/w", aliases } : { cwd: "/w" }).map(render);
}

function render(cmd: SimpleCommand): string {
  return [cmd.name, ...cmd.args.map((a) => a.value)].join(" ");
}

describe("alias reading of the command word", () => {
  it("reads g push as git push and keeps the as-written g", () => {
    const out = lines("g push origin HEAD:main", new Map([["g", ["git"]]]));

    expect(out).toEqual(["g push origin HEAD:main", "git push origin HEAD:main"]);
  });

  it.each([
    ["FOO=1 g push origin HEAD:main"],
    ["if g push origin HEAD:main; then :; fi"],
    ["eval 'g push origin HEAD:main'"],
    ["a=gp; gp origin HEAD:main"],
    ["s g push origin HEAD:main"],
    ["\\g push origin HEAD:main"],
    ["'g' push origin HEAD:main"],
  ])("reads %s as a git push", (src) => {
    expect(lines(src)).toContain("git --no-pager push origin HEAD:main");
  });

  it("keeps g -C /tmp as git's option", () => {
    const [cmd] = extractCommands("g -C /tmp push origin HEAD:main", { aliases: new Map([["g", ["git"]]]) }).filter((c) => c.name === "git");

    expect(cmd?.args.map((a) => a.value)).toEqual(["-C", "/tmp", "push", "origin", "HEAD:main"]);
  });

  it("stops a self-referential alias after one expansion", () => {
    expect(lines("git push origin HEAD:main")).toEqual(["git push origin HEAD:main", "git --no-pager push origin HEAD:main"]);
  });

  it("reads every value a name carries", () => {
    const out = lines("g status", new Map([["g", ["git", "grep"]]]));

    expect(out).toEqual(["g status", "git status", "grep status"]);
  });

  it("walks an operator-holding value as eval text, in its directory", () => {
    const cmds = extractCommands("x origin HEAD:main", { cwd: "/w", aliases: ALIASES });
    const push = cmds.find((c) => c.name === "git" && c.args[0]?.value === "push");

    expect(cmds.map(render)).toEqual(["x origin HEAD:main", "git push origin HEAD:main", "git --no-pager push origin HEAD:main"]);
    expect(push?.dir).toBe("/r");
    expect(push?.wrapping).toEqual(["eval"]);
  });

  it("keeps the as-written cp beside its nocorrect expansion", () => {
    expect(lines("cp ~/.npmrc /tmp/x")).toEqual(["cp ~/.npmrc /tmp/x", "nocorrect cp ~/.npmrc /tmp/x"]);
  });

  it.each([
    ["git push origin HEAD:main", new Map([["git", ["git --x | cat"]]]), "git push origin HEAD:main"],
    ["x origin HEAD:main", new Map([["x", ["cd /r && git push"]]]), "git push origin HEAD:main"],
    ["gp origin HEAD:main", new Map([["gp", ["g push"]], ["g", ["git"]], ["git", ["git $GIT_OPTS"]]]), "git $GIT_OPTS push origin HEAD:main"],
  ])("still reads %s as a git push through a self-naming eval-text value", (src, aliases, push) => {
    expect(lines(src, aliases)).toContain(push);
  });

  it("refuses a command whose alias value the lexer rejects", () => {
    expect(() => lines("bad")).toThrow(ParseError);
    expect(lines("echo bad")).toEqual(["echo bad"]);
  });

  it("leaves a command xargs runs to PATH", () => {
    expect(lines("echo x | xargs g push", new Map([["g", ["git"]]]))).toEqual(["echo x", "g push x"]);
  });

  it.each([
    ["ls -la", new Map([["ls", ["ls --color=$X"]]]), ["ls -la", "ls --color=$X -la"]],
    ["sr a", new Map([["sr", ["sr --x | cat"]]]), ["sr a", "sr --x", "cat a"]],
    ["m1", new Map([["m1", ["m2; :"]], ["m2", ["m1; :"]]]), ["m1", "m2", "m1", ":", ":"]],
  ])("expands %s once inside its own eval-text value", (src, aliases, expected) => {
    expect(lines(src, aliases)).toEqual(expected);
  });

  it.each([
    ["g push origin HEAD:main"],
    ["eval 'g push origin HEAD:main'"],
    ["FOO=1 g push origin HEAD:main"],
    ["g -C /tmp push origin HEAD:main"],
  ])("reads %s as written with no alias table", (src) => {
    expect(lines(src, null).some((line) => line.startsWith("git"))).toBe(false);
    expect(lines(src, null)).toEqual(lines(src, new Map()));
  });
});
