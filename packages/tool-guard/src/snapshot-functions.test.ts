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

    expect([...table.functions.keys()]).toEqual(["gp", ".zinit-outer"]);
    expect(table.functions.get("gp")).toEqual({ body: GP_BODY });
    expect(table.functions.get(".zinit-outer")).toEqual({ body: OUTER_BODY });
    expect(table.incomplete).toBe(false);
  });

  it("never reads Claude Code's trailing rg and pkill wrappers", () => {
    const { functions } = parseSnapshotFunctions(SNAPSHOT);

    expect(functions.has("rg")).toBe(false);
    expect(functions.has("pkill")).toBe(false);
  });

  it("returns an empty, complete table when the snapshot has no # Functions header", () => {
    const table = parseSnapshotFunctions("# Snapshot file\n# Aliases\nfunction pkill {\n  :\n}\n");

    expect(table).toEqual({ functions: new Map(), incomplete: false });
  });

  it("reads past a heredoc holding a column-0 } and a # section line, and keeps the function after it", () => {
    const table = parseSnapshotFunctions(
      snapshot(".a () {", "\tcat <<EOF", "}", "# Aliases", "EOF", "}", "gp () {", "\tgit push", "}"),
    );

    expect(table.functions.get(".a")).toEqual({ body: "\tcat <<EOF\n}\n# Aliases\nEOF" });
    expect(table.functions.get("gp")).toEqual({ body: "\tgit push" });
    expect(table.incomplete).toBe(false);
  });

  it("does not let a header-shaped heredoc delimiter redefine an earlier function", () => {
    const table = parseSnapshotFunctions(
      snapshot("gp () {", "\tgit push", "}", "x () {", "\tcat <<'gp () {'", "}", "gp () {", "\techo safe", "}"),
    );

    expect(table.functions.get("gp")).toEqual({ body: "\tgit push" });
    expect(table.functions.get("x")).toEqual({ body: "\tcat <<'gp () {'\n}\ngp () {\n\techo safe" });
    expect(table.incomplete).toBe(true);
  });

  it("keeps a body whole when its heredoc spans what looks like another function", () => {
    const table = parseSnapshotFunctions(
      snapshot("a () {", "\tcat <<EOF", "}", "b () {", "\tls", "}", "EOF", "\tgit push", "}"),
    );

    expect(table.functions.get("a")).toEqual({ body: "\tcat <<EOF\n}\nb () {\n\tls\n}\nEOF\n\tgit push" });
    expect(table.functions.has("b")).toBe(false);
    expect(table.incomplete).toBe(true);
  });

  it("reads << in an arithmetic command as a shift, not a heredoc", () => {
    const table = parseSnapshotFunctions(
      snapshot("a () {", "\t(( y = x << n ))", "}", "gp () {", '\tgit push "$@"', "}", "b () {", "\tcat <<EOF", "n", "EOF", "}"),
    );

    expect([...table.functions.keys()]).toEqual(["a", "gp", "b"]);
    expect(table.functions.get("gp")).toEqual({ body: '\tgit push "$@"' });
    expect(table.incomplete).toBe(false);
  });

  it("sees a heredoc inside a (( that proves to be nested subshells, so a duplicate cannot hide the real body", () => {
    const table = parseSnapshotFunctions(
      snapshot("gp () {", "\tgit push", "}", "zz () {", "\tx=$(", "((cat <<EOF) )", "}", "gp () {", "\techo safe", "EOF", ")", "}"),
    );

    expect(table.functions.get("gp")).toEqual({ body: "\tgit push" });
    expect(table.functions.get("zz")).toEqual({ body: "\tx=$(\n((cat <<EOF) )\n}\ngp () {\n\techo safe\nEOF\n)" });
  });

  it("sees a heredoc inside a (( that proves to be nested subshells, so a made-up name cannot take the real body", () => {
    const table = parseSnapshotFunctions(
      snapshot("zz () {", "\tx=$(", "((cat <<EOF) )", "}", "zzz () {", "\techo safe", "EOF", ")", "\tgit push origin HEAD:main", "}"),
    );

    expect(table.functions.has("zzz")).toBe(false);
    expect(table.functions.get("zz")).toEqual({
      body: "\tx=$(\n((cat <<EOF) )\n}\nzzz () {\n\techo safe\nEOF\n)\n\tgit push origin HEAD:main",
    });
  });

  it("reads a quote inside a comment in $( ) as comment text", () => {
    const table = parseSnapshotFunctions(
      snapshot("a () {", "\tx=$(: # it's", ")", "}", "gp () {", '\tgit push "$@"', "}", "b () {", "\tcat <<EOF", "')", "EOF", "}"),
    );

    expect([...table.functions.keys()]).toEqual(["a", "gp", "b"]);
    expect(table.functions.get("gp")).toEqual({ body: '\tgit push "$@"' });
    expect(table.incomplete).toBe(false);
  });

  it("keeps a body whole when a multi-line string holds a column-0 }", () => {
    const table = parseSnapshotFunctions(snapshot("q () {", '\techo "x', "}", '"', "\tgit push", "}"));

    expect(table.functions.get("q")).toEqual({ body: '\techo "x\n}\n"\n\tgit push' });
  });

  it("marks a cut-off body unreadable and the table incomplete", () => {
    const table = parseSnapshotFunctions("# Functions\nok () {\n\t:\n}\ncut () {\n\tgit push origin");

    expect(table.functions.get("ok")).toEqual({ body: "\t:" });
    expect(table.functions.get("cut")).toEqual({ unreadable: true });
    expect(table.incomplete).toBe(true);
  });

  it("marks a body whose heredoc never closes unreadable and the table incomplete", () => {
    const table = parseSnapshotFunctions(snapshot("h () {", "\tcat <<EOF", "}", "gp () {", "\tgit push", "}"));

    expect(table.functions.get("h")).toEqual({ unreadable: true });
    expect(table.incomplete).toBe(true);
  });

  it("marks the table incomplete at a header it cannot read, even as the first function", () => {
    const table = parseSnapshotFunctions(snapshot("'a b' () {", "\tgit push", "}", "gp () {", "\tls", "}"));

    expect(table.functions.size).toBe(0);
    expect(table.incomplete).toBe(true);
  });

  it("marks the previous function unreadable when a stray line follows its }", () => {
    const table = parseSnapshotFunctions(snapshot("gp () {", "\tgit push", "}", "stray", "later () {", "\tls", "}"));

    expect(table.functions.get("gp")).toEqual({ unreadable: true });
    expect(table.functions.has("later")).toBe(false);
    expect(table.incomplete).toBe(true);
  });

  it("marks the table incomplete when the text ends before the section does", () => {
    const table = parseSnapshotFunctions("# Functions\ngp () {\n\tgit push\n}\n");

    expect(table.functions.get("gp")).toEqual({ body: "\tgit push" });
    expect(table.incomplete).toBe(true);
  });

  it("marks a CRLF snapshot incomplete instead of reading it as having no functions", () => {
    const table = parseSnapshotFunctions("# Snapshot file\r\n# Functions\r\ngp () {\r\n\tgit push\r\n}\r\n");

    expect(table.incomplete).toBe(true);
  });

  it("keeps the later body when a name is defined twice", () => {
    const { functions } = parseSnapshotFunctions(snapshot("gp () {", "\techo first", "}", "gp () {", "\tgit push", "}"));

    expect(functions.get("gp")).toEqual({ body: "\tgit push" });
  });

  it("reads a bash declare -f shape, a function NAME { header and an empty body", () => {
    const { functions } = parseSnapshotFunctions(
      snapshot("gp () ", "{ ", '    git push "$@"', "}", "function gpm {", '\tgit push origin "$1"', "}", "e () {", "}"),
    );

    expect(functions.get("gp")).toEqual({ body: '    git push "$@"' });
    expect(functions.get("gpm")).toEqual({ body: '\tgit push origin "$1"' });
    expect(functions.get("e")).toEqual({ body: "" });
  });
});
