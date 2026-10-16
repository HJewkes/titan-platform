import { describe, expect, it } from "vitest";
import { extractCommands } from "./commands.js";

const names = (line: string) => extractCommands(line).map((c) => c.name);

describe("operators inside [[ ]]", () => {
  it("keeps && inside one [[ command", () => {
    const cmds = extractCommands("[[ -n $x && $y == z ]] # c");
    expect(cmds.map((c) => c.name)).toEqual(["[["]);
  });

  it("keeps || inside one [[ command", () => {
    expect(names("[[ a || b ]]")).toEqual(["[["]);
  });

  it("still splits a list operator after the closing ]]", () => {
    expect(names("[[ a ]] && b")).toEqual(["[[", "b"]);
    expect(names("[[ a ]] || b")).toEqual(["[[", "b"]);
  });

  it("still walks a substitution after && inside [[", () => {
    expect(names("[[ -n x && $(git status) ]]")).toContain("git");
  });

  it.each([
    ["a glued &&", "[[ a ]]&&git push"],
    ["a glued ||", "[[ a ]]||git push"],
    ["a newline then &&", "[[ a ]]\n&& git push"],
    ["a negated test", "! [[ a ]]&&git push"],
    ["a timed test", "time [[ a ]]&&git push"],
    ["a function body", "f() [[ a ]]&&git push"],
    ["a regex test", "[[ a =~ b ]]&&git push"],
  ])("splits git off a test closed by ]] with %s", (_scenario, line) => {
    expect(names(line)).toContain("git");
  });

  it.each([
    "time -p -p [[ a || git push ]]",
    "time -- -- [[ a || git push ]]",
    "time -- -p [[ a || git push ]]",
    "time -p -p -- [[ a || git push ]]",
    "time -- [[ a || git push ]]",
  ])("splits git off a [[ bash does not open: %s", (line) => {
    expect(names(line)).toContain("git");
  });

  it.each([
    "time -p [[ a || git push ]]",
    "time -p -- [[ a || git push ]]",
    "time\t-p [[ a || git push ]]",
    "! time -p [[ a || git push ]]",
    "if time -p [[ a || git push ]]; then :; fi",
    "{ time -p [[ a || git push ]]; }",
    "time -p time [[ a || git push ]]",
  ])("splits git off a [[ after a time option zsh reads as the command: %s", (line) => {
    expect(names(line)).toContain("git");
  });

  it.each(["time [[ a || b ]]", "! time [[ a || b ]]", "time time [[ a || b ]]"])("keeps one conditional after a bare time: %s", (line) => {
    expect(names(line)).not.toContain("b");
  });
});
