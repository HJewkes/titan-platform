import { describe, expect, it } from "vitest";
import { noteRows } from "./note-rows.js";

describe("noteRows", () => {
  it("reads a label at the start of a line", () => {
    expect(noteRows("WHY WAITING: the kiln is cold")).toEqual([{ label: "WHY WAITING", value: "the kiln is cold" }]);
  });

  it("splits labels that appear mid-line", () => {
    expect(noteRows("HEAD: 02ff498f. RECOMMENDATION: FIX.")).toEqual([
      { label: "HEAD", value: "02ff498f." },
      { label: "RECOMMENDATION", value: "FIX." },
    ]);
  });

  it("keeps plain text as one unlabelled row per line", () => {
    expect(noteRows("First line.\nSecond line.")).toEqual([
      { label: null, value: "First line." },
      { label: null, value: "Second line." },
    ]);
  });

  it("keeps text before the first label", () => {
    expect(noteRows("Heads up. WHAT: a jar")).toEqual([
      { label: null, value: "Heads up." },
      { label: "WHAT", value: "a jar" },
    ]);
  });

  it("does not take a colon inside a value for a label", () => {
    expect(noteRows("WHAT: see https://example.test/jar at 10:30 AM")).toEqual([{ label: "WHAT", value: "see https://example.test/jar at 10:30 AM" }]);
    expect(noteRows("OPENS AT 10:30")).toEqual([{ label: null, value: "OPENS AT 10:30" }]);
  });

  it("does not take lowercase or mixed-case words for labels", () => {
    expect(noteRows("Note: lower case stays text")).toEqual([{ label: null, value: "Note: lower case stays text" }]);
  });

  it("drops blank lines and keeps a label with no value", () => {
    expect(noteRows("EVIDENCE:\n\nWHAT: x")).toEqual([
      { label: "EVIDENCE", value: "" },
      { label: "WHAT", value: "x" },
    ]);
  });
});
