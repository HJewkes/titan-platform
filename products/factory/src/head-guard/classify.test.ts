import { describe, expect, it } from "vitest";
import {
  advances,
  classifyHeadRead,
  staleAfterWrite,
  staleMain,
  type HeadClass,
  type HeadReadInput,
  type StoredHead,
} from "./classify.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

const storedB: StoredHead = { head: B, epoch: 2, earlierConfirmed: [A] };
const read = (over: Partial<HeadReadInput>): HeadClass =>
  classifyHeadRead({ stored: storedB, read: C, now: 100, ...over });

describe("classifyHeadRead", () => {
  it("treats an unchanged head as same without asking ancestry", () => {
    expect(read({ read: B })).toEqual({ kind: "same" });
  });

  it("confirms a descendant of the stored head as a fast-forward", () => {
    expect(read({ ancestry: "ahead" })).toEqual({ kind: "confirmed", by: "fast-forward" });
  });

  it("confirms an unrelated, never-seen head as non-ancestor", () => {
    expect(read({ ancestry: "diverged" })).toEqual({ kind: "confirmed", by: "non-ancestor" });
  });

  it("holds an ancestor of the stored head as suspect until ls-remote answers", () => {
    expect(read({ ancestry: "behind" })).toEqual({ kind: "suspect", needs: "ls-remote" });
  });

  it("confirms a force-push back to an ancestor when ls-remote agrees", () => {
    expect(read({ ancestry: "behind", lsRemote: C })).toEqual({ kind: "confirmed", by: "ls-remote" });
  });

  it("calls a lagging ancestor stale when ls-remote still shows the stored head", () => {
    expect(read({ ancestry: "behind", lsRemote: B })).toEqual({ kind: "stale", reason: "ancestor-of-stored" });
  });

  it("calls a read stale when ls-remote shows a third head", () => {
    expect(read({ ancestry: "behind", lsRemote: D })).toEqual({ kind: "stale", reason: "ls-remote-disagrees" });
  });

  it("calls a read stale when ls-remote has no pull ref", () => {
    expect(read({ ancestry: "behind", lsRemote: null })).toEqual({ kind: "stale", reason: "ls-remote-disagrees" });
  });

  it("does not confirm a lagging pre-force-push head that diverged from the stored head (I5)", () => {
    const suspect = read({ read: A, ancestry: "diverged" });
    expect(suspect).toEqual({ kind: "suspect", needs: "ls-remote" });
    expect(read({ read: A, ancestry: "diverged", lsRemote: B })).toEqual({
      kind: "stale",
      reason: "earlier-confirmed-head",
    });
  });

  it("confirms a return to an earlier head only through ls-remote", () => {
    expect(read({ read: A, ancestry: "diverged", lsRemote: A })).toEqual({ kind: "confirmed", by: "ls-remote" });
  });

  it("calls a missing commit stale", () => {
    expect(read({ ancestry: "missing" })).toEqual({ kind: "stale", reason: "ancestry-missing" });
  });

  it("passes an unavailable ancestry read through", () => {
    const unavailable = { kind: "unavailable", resetAt: "2026-01-01T00:00:00Z" } as const;
    expect(read({ ancestry: unavailable })).toEqual(unavailable);
  });

  it("passes an unavailable ls-remote read through", () => {
    const unavailable = { kind: "unavailable" } as const;
    expect(read({ ancestry: "behind", lsRemote: unavailable })).toEqual(unavailable);
  });
});

describe("classifyHeadRead without a stored row", () => {
  const first = (over: Partial<HeadReadInput>): HeadClass => classifyHeadRead({ stored: undefined, read: A, now: 1, ...over });

  it("needs a second agreeing read", () => {
    expect(first({})).toEqual({ kind: "suspect", needs: "second-read" });
  });

  it("bootstraps when ls-remote agrees", () => {
    expect(first({ lsRemote: A })).toEqual({ kind: "confirmed", by: "bootstrap" });
  });

  it("is stale when ls-remote disagrees", () => {
    expect(first({ lsRemote: B })).toEqual({ kind: "stale", reason: "ls-remote-disagrees" });
  });

  it("passes an unavailable ls-remote read through", () => {
    expect(first({ lsRemote: { kind: "unavailable" } })).toEqual({ kind: "unavailable" });
  });
});

describe("classifyHeadRead own-write floor", () => {
  const floor = (readVsFloor: "ahead" | "behind" | "diverged" | "missing", expiresAt = 200) => ({
    sha: C,
    expiresAt,
    readVsFloor,
  });

  it("calls an ancestor of the floor stale", () => {
    expect(read({ read: D, ancestry: "ahead", floor: floor("behind") })).toEqual({
      kind: "stale",
      reason: "below-own-write",
    });
  });

  it("calls a head outside the floor and its descendants stale", () => {
    expect(read({ read: D, ancestry: "diverged", floor: floor("diverged") })).toEqual({
      kind: "stale",
      reason: "below-own-write",
    });
  });

  it("lets the floor head itself through", () => {
    expect(read({ read: C, ancestry: "ahead", floor: floor("behind") })).toEqual({ kind: "confirmed", by: "fast-forward" });
  });

  it("lets a descendant of the floor through", () => {
    expect(read({ read: D, ancestry: "ahead", floor: floor("ahead") })).toEqual({ kind: "confirmed", by: "fast-forward" });
  });

  it("ignores an expired floor", () => {
    expect(read({ read: D, ancestry: "ahead", floor: floor("behind", 100) })).toEqual({
      kind: "confirmed",
      by: "fast-forward",
    });
  });

  it("passes an unavailable floor comparison through", () => {
    const unavailable = { kind: "unavailable" } as const;
    const outcome = read({ read: D, ancestry: "ahead", floor: { sha: C, expiresAt: 200, readVsFloor: unavailable } });
    expect(outcome).toEqual(unavailable);
  });
});

describe("advances", () => {
  const cases: [string, HeadClass, boolean][] = [
    ["same", { kind: "same" }, false],
    ["suspect", { kind: "suspect", needs: "ls-remote" }, false],
    ["stale", { kind: "stale", reason: "ancestry-missing" }, false],
    ["unavailable", { kind: "unavailable" }, false],
    ["confirmed bootstrap", { kind: "confirmed", by: "bootstrap" }, true],
    ["confirmed non-ancestor", { kind: "confirmed", by: "non-ancestor" }, true],
    ["confirmed fast-forward", { kind: "confirmed", by: "fast-forward" }, true],
    ["confirmed ls-remote", { kind: "confirmed", by: "ls-remote" }, true],
  ];

  it.each(cases)("%s advances only when confirmed (I2)", (_name, outcome, expected) => {
    expect(advances(outcome)).toBe(expected);
  });
});

describe("staleMain", () => {
  it("is stale when equal to an earlier expected main", () => {
    expect(staleMain(A, [A, B], [])).toBe(true);
  });

  it("is stale when equal to a lander result", () => {
    expect(staleMain(B, [A], [B])).toBe(true);
  });

  it("is not stale for a new tip", () => {
    expect(staleMain(C, [A], [B])).toBe(false);
  });
});

describe("staleAfterWrite", () => {
  it.each([
    ["a 404", { kind: "http", status: 404 } as const, true],
    ["a 200", { kind: "http", status: 200 } as const, false],
    ["merged: false", { kind: "merged", merged: false } as const, true],
    ["merged: true", { kind: "merged", merged: true } as const, false],
    ["a missing commit", { kind: "commit", found: false } as const, true],
    ["a found commit", { kind: "commit", found: true } as const, false],
  ])("%s", (_name, answer, expected) => {
    expect(staleAfterWrite(answer)).toBe(expected);
  });
});
