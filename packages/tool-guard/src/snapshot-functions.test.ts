import { describe, expect, it } from "vitest";
import { parseSnapshotFunctions } from "./snapshot-functions.js";

const GP_BODY = '\tgit push "$@"';
const OUTER_BODY = ['\tinner () {', '\t\tgit push origin "$1"', "\t}", '\tinner "$@"'].join("\n");

const SNAPSHOT = [
  "# Snapshot file",
  "# Unset all aliases to avoid conflicts with functions",
  "unalias -a 2>/dev/null || true",
  "# Functions",
  "gp () {",
  GP_BODY,
  "}",
  ".zinit-outer () {",
  OUTER_BODY,
  "}",
  "# Shell Options",
  "setopt nohashdirs",
  "# Aliases",
  "alias -- g=git",
  "# Check for rg availability",
  "if ! (unalias rg 2>/dev/null; typeset -f rg >/dev/null 2>&1); then",
  "  function rg {",
  '  ARGV0=rg "$_cc_bin" ${1+"$@"}',
  "}",
  "fi",
  "# Shadow pkill to refuse patterns matching the CLI process",
  "function pkill {",
  '  command pkill "$@"',
  "}",
  "export PATH=/usr/bin",
].join("\n");

function snapshot(...functionLines: string[]): string {
  return ["# Snapshot file", "# Functions", ...functionLines, "# Shell Options", "setopt nohashdirs"].join("\n");
}

describe("parseSnapshotFunctions", () => {
  it("reads only the # Functions section, with bodies byte-equal to the indented lines", () => {
    const table = parseSnapshotFunctions(SNAPSHOT);

    expect([...table.keys()]).toEqual(["gp", ".zinit-outer"]);
    expect(table.get("gp")).toEqual({ body: GP_BODY });
    expect(table.get(".zinit-outer")).toEqual({ body: OUTER_BODY });
  });

  it("never reads Claude Code's trailing rg and pkill wrappers", () => {
    const table = parseSnapshotFunctions(SNAPSHOT);

    expect(table.has("rg")).toBe(false);
    expect(table.has("pkill")).toBe(false);
  });

  it("returns an empty table when the snapshot has no # Functions header", () => {
    const table = parseSnapshotFunctions("# Snapshot file\n# Aliases\nfunction pkill {\n  :\n}\n");

    expect(table.size).toBe(0);
  });

  it("marks a body ended early by a column-0 } heredoc line unreadable, and parses the next clean header", () => {
    const table = parseSnapshotFunctions(
      snapshot("cut () {", "\tcat <<EOF", "}", "x", "EOF", "\tgit push origin HEAD:main", "}", "after () {", "\tls", "}"),
    );

    expect(table.get("cut")).toEqual({ unreadable: true });
    expect(table.get("after")).toEqual({ body: "\tls" });
  });

  it("marks a header-shaped heredoc line seen while out of step unreadable", () => {
    const table = parseSnapshotFunctions(snapshot("cut () {", "\tcat <<EOF", "}", "x", "fake () {", "EOF", "}"));

    expect(table.get("cut")).toEqual({ unreadable: true });
    expect(table.get("fake")).toEqual({ unreadable: true });
  });

  it("marks a body with no closing } unreadable", () => {
    const table = parseSnapshotFunctions("# Functions\nok () {\n\t:\n}\ncut () {\n\tgit push origin");

    expect(table.get("ok")).toEqual({ body: "\t:" });
    expect(table.get("cut")).toEqual({ unreadable: true });
  });

  it("keeps the later body when a name is defined twice", () => {
    const table = parseSnapshotFunctions(snapshot("gp () {", "\techo first", "}", "gp () {", "\tgit push", "}"));

    expect(table.get("gp")).toEqual({ body: "\tgit push" });
  });

  it("reads a bash declare -f shape and a function NAME { header", () => {
    const table = parseSnapshotFunctions(
      snapshot("gp () ", "{ ", '    git push "$@"', "}", "function gpm {", '\tgit push origin "$1"', "}"),
    );

    expect(table.get("gp")).toEqual({ body: '    git push "$@"' });
    expect(table.get("gpm")).toEqual({ body: '\tgit push origin "$1"' });
  });
});
