import { describe, expect, it } from "vitest";
import { parseSnapshotFunctions } from "./snapshot-functions.js";

/** Misjudges every column-0 `}` but the last, as a scan that missed a heredoc or quote would. */
function lastClose(lines: string[]): number {
  return lines.lastIndexOf("}");
}

describe("parseSnapshotFunctions with a body scan that runs past a body's real end", () => {
  it("marks the table incomplete when a body swallows a later function's header", () => {
    const text = ["# Functions", "a () {", "\tx", "}", "gp () {", "\tgit push", "}", "b () {", "\tls", "}", "# Aliases"].join("\n");

    const table = parseSnapshotFunctions(text, lastClose);

    expect([...table.functions.keys()]).toEqual(["a"]);
    expect(table.incomplete).toBe(true);
  });
});
