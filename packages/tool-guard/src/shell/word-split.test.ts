import { describe, expect, it } from "vitest";
import { extractCommands } from "./commands.js";

const names = (line: string) => extractCommands(line).map((c) => c.name);

describe("&& and || inside a [[ at a bare command start", () => {
  it.each([
    "[[ -n $x && $y == z ]] # c",
    "[[ a || b ]]",
    "x; [[ a && b ]]",
    "x && [[ a || b ]]",
    "( [[ a && b ]] )",
    "x\n[[ a && b ]]",
    "x | [[ a && b ]]",
    "x & [[ a && b ]]",
  ])("reads one [[ command: %j", (line) => {
    expect(names(line).filter((n) => n === "[[")).toHaveLength(1);
    expect(names(line)).not.toContain("b");
    expect(names(line)).not.toContain("=");
    expect(names(line)).not.toContain(null);
  });

  it("still walks a substitution after && inside [[", () => {
    expect(names("[[ -n x && $(git status) ]]")).toContain("git");
  });

  it("still splits a list operator after the closing ]]", () => {
    expect(names("[[ a ]] && b")).toEqual(["[[", "b"]);
    expect(names("[[ a ]] || b")).toEqual(["[[", "b"]);
  });
});

describe("a [[ anywhere else keeps the split reading", () => {
  it.each([
    "! [[ a || git push ]]",
    "time [[ a || git push ]]",
    "time -p [[ a || git push ]]",
    "time -p -p [[ a || git push ]]",
    "time -p ! [[ a || git push ]]",
    "time time [[ a || git push ]]",
    "if [[ a || git push ]]; then :; fi",
    "while [[ a || git push ]]; do :; done",
    "{ [[ a || git push ]]; }",
    "$(true)[[ a || git push ]]",
    "`true`[[ a || git push ]]",
    "[[$(true) a || git push ]]",
    "x=1 [[ a || git push ]]",
    ">f [[ a || git push ]]",
    "coproc [[ a || git push ]]",
    "nocorrect [[ a || git push ]]",
    "builtin [[ a || git push ]]",
    "command [[ a || git push ]]",
    "exec [[ a || git push ]]",
    "case x in a) [[ a || git push ]];; esac",
    "f() [[ a || git push ]]",
  ])("reports git: %j", (line) => {
    expect(names(line)).toContain("git");
  });
});

describe("a ]] glued to an operator still closes", () => {
  it.each([
    "[[ a ]]&&git push",
    "[[ a ]]||git push",
    "[[ a ]]\\\n&& git push",
    "[[ a ]]\n&& git push",
    "[[ a ]]|git push",
    "[[ a ]]&git push",
    "[[ a ]];git push",
    "[[ a =~ b ]]&&git push",
  ])("reports git: %j", (line) => {
    expect(names(line)).toContain("git");
  });
});
