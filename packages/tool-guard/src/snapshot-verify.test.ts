import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseSnapshotFunctions } from "./snapshot-functions.js";
import { trustedFunctions } from "./snapshot-verify.js";

const zshOnPath = spawnSync("zsh", ["--version"]).status === 0;

function snapshot(...functionLines: string[]): string {
  return ["# Snapshot file", "# Functions", ...functionLines, "# Shell Options", "setopt nohashdirs"].join("\n");
}

// zsh reads the ' inside "${x:-'}" as a literal, so the $' on the next line holds every line up to '\'.
const CUT_BY_PARAM_QUOTE = snapshot(
  "zz () {", '\techo "${x:-\'}"', "\techo $'", "\\'}\"", "}",
  "zzz () {", "\techo safe", "'\\'", "\tgit push origin HEAD:main", "}",
);

describe("trustedFunctions", () => {
  it.runIf(zshOnPath)("rejects a body the scanner cut short, and the made-up function after it", () => {
    const table = parseSnapshotFunctions(CUT_BY_PARAM_QUOTE);
    const lookup = trustedFunctions(table);

    expect(table.functions.get("zz")).toEqual({ body: '\techo "${x:-\'}"\n\techo $\'\n\\\'}"' });
    expect(table.incomplete).toBe(false);
    expect(lookup("zz")).toEqual({ unreadable: true });
    expect(lookup("zzz")).toEqual({ unreadable: true });
  });

  it.runIf(zshOnPath)("trusts bodies zsh parses standalone", () => {
    const lookup = trustedFunctions(parseSnapshotFunctions(snapshot("gp () {", '\tgit push "$@"', "}", "h () {", "\tcat <<EOF", "}", "EOF", "}")));

    expect(lookup("gp")).toEqual({ body: '\tgit push "$@"' });
    expect(lookup("h")).toEqual({ body: "\tcat <<EOF\n}\nEOF" });
  });

  it("parses each body once, only up to the furthest function looked up", () => {
    const scripts: string[] = [];
    const lookup = trustedFunctions(parseSnapshotFunctions(snapshot("a () {", "\t:", "}", "b () {", "\t:", "}", "c () {", "\t:", "}")), (script) => {
      scripts.push(script);
      return true;
    });

    lookup("b");
    lookup("a");
    lookup("missing");

    expect(scripts).toEqual(["a () {\n\t:\n}", "b () {\n\t:\n}"]);
  });

  it("distrusts every function after the first body that fails to parse", () => {
    const lookup = trustedFunctions(parseSnapshotFunctions(snapshot("a () {", "\t:", "}", "b () {", "\tbad", "}", "c () {", "\t:", "}")), (script) => !script.includes("bad"));

    expect(lookup("c")).toEqual({ unreadable: true });
    expect(lookup("b")).toEqual({ unreadable: true });
    expect(lookup("a")).toEqual({ body: "\t:" });
  });

  it("returns undefined for a name the table does not hold", () => {
    const lookup = trustedFunctions(parseSnapshotFunctions(snapshot("a () {", "\t:", "}")), () => true);

    expect(lookup("git")).toBeUndefined();
  });
});
