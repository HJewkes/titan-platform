import { describe, expect, it } from "vitest";
import { labelledLineRest } from "./labelled-line.js";

describe("labelledLineRest", () => {
  it.each(["- Note: kept", "**Note:** kept", "> Note: kept", "NOTE: kept", "Note：kept", "1. Note - kept"])("a decorated label %s reads the folded rest", (raw) => {
    expect(labelledLineRest(raw, "Note:")).toBe("kept");
  });

  it("an unlabelled line reads undefined", () => {
    expect(labelledLineRest("Other: kept", "Note:")).toBeUndefined();
  });

  it("a label glued to an identifier is a code name unless its rest starts the strict value", () => {
    expect(labelledLineRest("note-book: kept", "Note:")).toBeUndefined();
    expect(labelledLineRest("note_strict: x", "Note:", "strict")).toBe("strictx");
  });
});
