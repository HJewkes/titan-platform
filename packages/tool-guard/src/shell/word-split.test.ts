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
});
