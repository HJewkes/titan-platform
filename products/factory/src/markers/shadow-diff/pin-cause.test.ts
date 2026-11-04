import type { DiffPin, MergeUpProof } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { pinCause, type PinProbe } from "./pin-cause.js";

const exact = (full: string, core: string): DiffPin => ({ kind: "exact", head: "h1", base: "b1", main: "m1", full, core });
const ambiguous: DiffPin = { kind: "ambiguous", head: "h1", main: "m1", bases: ["b1", "b2"] };
const ok: MergeUpProof = { ok: true, mainParent: "m1" };
const failed: MergeUpProof = { ok: false, reason: "conflict" };

function probe(over: Partial<PinProbe>): PinProbe {
  return { reviewed: exact("f1", "c1"), current: exact("f2", "c1"), mergeUp: failed, headIsMerge: false, wsBlindCoreEqual: false, ...over };
}

describe("pinCause", () => {
  it("an ambiguous base on either side is ambiguous-base", () => {
    const equalHashes = { reviewed: ambiguous, current: ambiguous };
    expect(pinCause(probe(equalHashes))).toEqual({ class: "pin-differs", cause: "ambiguous-base" });
    expect(pinCause(probe({ reviewed: ambiguous }))).toEqual({ class: "pin-differs", cause: "ambiguous-base" });
    expect(pinCause(probe({ current: ambiguous, mergeUp: ok }))).toEqual({ class: "pin-differs", cause: "ambiguous-base" });
  });

  it("equal full hashes agree; equal core plus a proved merge-up agrees as exclusion 2", () => {
    expect(pinCause(probe({ current: exact("f1", "c9") }))).toEqual({ class: "carry-agrees", exclusion2: false });
    expect(pinCause(probe({ mergeUp: ok, headIsMerge: true }))).toEqual({ class: "carry-agrees", exclusion2: true });
  });

  it("equal core on a merge whose merge-up proof fails is conflict-merge-up; on a non-merge it is rebase-context", () => {
    expect(pinCause(probe({ headIsMerge: true }))).toEqual({ class: "pin-differs", cause: "conflict-merge-up" });
    expect(pinCause(probe({ headIsMerge: false }))).toEqual({ class: "pin-differs", cause: "rebase-context" });
  });

  it("a core that differs only in whitespace is whitespace", () => {
    const differing = { current: exact("f2", "c2") };
    expect(pinCause(probe({ ...differing, wsBlindCoreEqual: true }))).toEqual({ class: "pin-differs", cause: "whitespace" });
  });

  it("any other difference is unclassified, and no probe is unprobed", () => {
    expect(pinCause(probe({ current: exact("f2", "c2") }))).toEqual({ class: "pin-differs", cause: "unclassified" });
    expect(pinCause(undefined)).toEqual({ class: "pin-differs", cause: "unprobed" });
  });
});
