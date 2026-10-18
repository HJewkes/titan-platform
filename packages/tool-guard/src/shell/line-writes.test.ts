import { describe, expect, it } from "vitest";
import { addLineWrites, copyVars, VALUE_SEPARATOR, writtenText } from "./line-writes.js";

const scopeWriting = (writes: Array<[string, string | null]>) => {
  const vars = new Map<string, string | null>();
  addLineWrites(vars, new Map(writes));
  return vars;
};

describe("a scope's write table", () => {
  it("reads a name the line never wrote as unwritten", () => {
    expect(writtenText(scopeWriting([["x", ""]]), "y")).toBeUndefined();
  });

  it("joins a name's texts from a nested line and the line that ran it", () => {
    const vars = scopeWriting([["x", "a"]]);
    addLineWrites(vars, new Map([["x", "b"], ["z", ""]]));

    expect(writtenText(vars, "x")?.split(VALUE_SEPARATOR).sort()).toEqual(["a", "b"]);
  });

  it("reads a name as unknown when one line's write is", () => {
    const vars = scopeWriting([["x", null]]);
    addLineWrites(vars, new Map([["x", "b"]]));

    expect(writtenText(vars, "x")).toBeNull();
  });

  it("shares the table with a copy, which a later write to the original leaves alone", () => {
    const vars = scopeWriting([["x", "a"]]);
    const copy = copyVars(vars);
    addLineWrites(vars, new Map([["x", null]]));

    expect(writtenText(copy, "x")).toBe("a");
  });

  it("reads every name as unknown in a copy that lost the table", () => {
    const lost = new Map(scopeWriting([["x", "a"]]));
    addLineWrites(lost, new Map([["z", ""]]));

    expect([writtenText(lost, "x"), writtenText(lost, "y")]).toEqual([null, null]);
  });
});
