import { describe, expect, it } from "vitest";
import { parseReviewVerdicts } from "./review-verdict.js";

describe("parseReviewVerdicts", () => {
  it("reads the verdict and a bare PR number from a dash-separated summary line", () => {
    const text = "PR #501 (widget cleanup) — Verdict: APPROVE";
    expect(parseReviewVerdicts(text)).toEqual([{ verdict: "approve", repo: null, repoHint: null, number: 501 }]);
  });

  it("keeps the word before the PR number as a repo hint", () => {
    const text = "acme-widgets #248 (routing fix) — Verdict: APPROVE";
    expect(parseReviewVerdicts(text)).toEqual([{ verdict: "approve", repo: null, repoHint: "acme-widgets", number: 248 }]);
  });

  it("never takes PR as a hint", () => {
    const text = "PR #501 (widget cleanup) — Verdict: APPROVE";
    expect(parseReviewVerdicts(text)[0]?.repoHint).toBeNull();
  });

  it("takes the PR from the first line when the verdict line names none", () => {
    const text = "Review of acme-widgets PR #248\n\n**Verdict:** request_changes";
    expect(parseReviewVerdicts(text)).toEqual([
      { verdict: "changes_requested", repo: null, repoHint: "acme-widgets", number: 248 },
    ]);
  });

  it("yields one verdict per PR named on one line", () => {
    const text = "PR #501, PR #502 — Verdict: LGTM";
    expect(parseReviewVerdicts(text)).toEqual([
      { verdict: "approve", repo: null, repoHint: null, number: 501 },
      { verdict: "approve", repo: null, repoHint: null, number: 502 },
    ]);
  });

  it("ignores a conditional approve in prose", () => {
    const text = "I would approve PR #501 once CI is green";
    expect(parseReviewVerdicts(text)).toEqual([]);
  });

  it("the last verdict line for a PR wins", () => {
    const text = "Verdict: CHANGES REQUESTED on PR #501\nVerdict: APPROVE after the fix, PR #501";
    expect(parseReviewVerdicts(text)).toEqual([{ verdict: "approve", repo: null, repoHint: null, number: 501 }]);
  });

  it("reads an exact owner/repo#n reference", () => {
    const text = "Verdict: CHANGES REQUESTED on acme/widgets#248";
    expect(parseReviewVerdicts(text)).toEqual([
      { verdict: "changes_requested", repo: "acme/widgets", repoHint: null, number: 248 },
    ]);
  });

  it("reads an exact repo from a github.com pull URL", () => {
    const text = "Verdict: APPROVE https://github.com/acme/widgets/pull/248";
    expect(parseReviewVerdicts(text)).toEqual([{ verdict: "approve", repo: "acme/widgets", repoHint: null, number: 248 }]);
  });

  it("parses a 100 KB single-line message in under 50ms", () => {
    const text = `Verdict: APPROVE — PR #501 — ${"filler text ".repeat(9000)}`;
    expect(text.length).toBeGreaterThan(100_000);
    const start = performance.now();
    const result = parseReviewVerdicts(text);
    const elapsed = performance.now() - start;
    expect(result).toEqual([{ verdict: "approve", repo: null, repoHint: null, number: 501 }]);
    expect(elapsed).toBeLessThan(50);
  });
});
