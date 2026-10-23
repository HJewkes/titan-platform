import { fakeSha } from "@titan-design/github";
import { usableScope } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import type { FixFirstEntry, FixFirstTrail } from "./fix-first-trail.js";
import { fixRoundOf, scopedBriefFields, scopedResultFields, toReviewScope } from "./review-scope-round.js";
import { scopeFromDiff } from "./review-scope.js";

const A = fakeSha("round-a");
const B = fakeSha("round-b");
const C = fakeSha("round-c");
const FIX_ROUND = { cause: "fix-round" } as const;
const entry = (headSha: string, text = `1. finding at ${headSha.slice(0, 6)}`): FixFirstEntry => ({ headSha, text });
const trail = (entries: FixFirstEntry[], extra: Partial<FixFirstTrail> = {}): FixFirstTrail => ({ fixFirstTrail: entries, ...extra });
const ciAt = (headSha: string) => ({ headSha, baseRef: "main" });

describe("fixRoundOf", () => {
  it("scopes a fix round against the newest finding's head, with every open finding and the base read at this head", () => {
    expect(fixRoundOf(trail([entry(A), entry(B)]), C, FIX_ROUND, ciAt(C))).toEqual({ fixRound: { sinceHead: B, baseRef: "main", openFindings: [entry(A), entry(B)] } });
  });

  it("leaves out the findings a MERGE answered and the fix-proof's NO_REPRO records", () => {
    const run = trail([entry(A), entry(B), { headSha: B, text: "", noRepro: true }], { openFrom: 1 });

    expect(fixRoundOf(run, C, FIX_ROUND, ciAt(C)).fixRound?.openFindings).toEqual([entry(B)]);
  });

  it("does not scope a retry, D8's convergence head, a head with no open finding, or the finding's own head", () => {
    expect(fixRoundOf(trail([entry(A)]), B, { cause: "retry", reason: "not-started" }, ciAt(B))).toEqual({});
    expect(fixRoundOf(trail([entry(A)], { convergedAt: B }), B, FIX_ROUND, ciAt(B))).toEqual({});
    expect(fixRoundOf(trail([entry(A)], { openFrom: 1 }), B, FIX_ROUND, ciAt(B))).toEqual({});
    expect(fixRoundOf(trail([entry(A)]), A, FIX_ROUND, ciAt(A))).toEqual({});
  });

  it("names no base when the last CI read was of another head", () => {
    expect(fixRoundOf(trail([entry(A)]), B, FIX_ROUND, ciAt(A)).fixRound).not.toHaveProperty("baseRef");
  });
});

const header = (path: string) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];

describe("toReviewScope", () => {
  it("maps the probe's line counts to inclusive ranges, a pure deletion to an end one below its start", () => {
    const unified = [...header("a.ts"), "@@ -3,0 +4,2 @@", "+x", "+y", "@@ -9 +11 @@", "-p", "+q", "@@ -20,3 +21,0 @@", "-r", "-s", "-t", ""].join("\n");
    const diff = scopeFromDiff("3\t4\ta.ts\0", unified);
    if ("reason" in diff) throw new Error(diff.reason);

    const scope = toReviewScope({ scoped: true, sinceHead: A, mergedBase: false, ...diff });

    expect(scope.hunks).toEqual([{ path: "a.ts", start: 4, end: 5 }, { path: "a.ts", start: 11, end: 11 }, { path: "a.ts", start: 21, end: 20 }]);
    expect(usableScope(scope, 1)).toBe(true);
  });
});

const SCOPE = { sinceHead: A, paths: ["a.ts"], hunks: [{ path: "a.ts", start: 1, end: 2 }], mergedBase: false };
const FINDINGS = [{ head: A, text: "1. finding" }];

describe("scopedBriefFields and scopedResultFields", () => {
  it("scope the brief only under on; shadow records the same scope and leaves the brief alone", () => {
    expect(scopedBriefFields({ mode: "on", scoped: true, scope: SCOPE, earlierFindings: FINDINGS })).toEqual({ scope: SCOPE, earlierFindings: FINDINGS });
    expect(scopedBriefFields({ mode: "shadow", scoped: true, scope: SCOPE, earlierFindings: FINDINGS })).toEqual({});
    expect(scopedResultFields({ mode: "shadow", scoped: true, scope: SCOPE, earlierFindings: FINDINGS })).toEqual({ scoped: true, scopeShadow: true });
    expect(scopedResultFields({ mode: "on", scoped: false, reason: "rebase" })).toEqual({ scoped: false, scopeReason: "rebase" });
    expect(scopedResultFields(undefined)).toEqual({});
  });
});
