import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheFileName, loadWindow } from "./gh-cache.js";
import { changesRequestedRounds, excludedReason, labelV2, pinWindow, type WindowPr } from "./label-v2.js";
import { v2Parity, type StoredCase } from "./parity.js";

const day = (n: number, hour = 0): string => new Date(Date.UTC(2026, 0, n, hour)).toISOString();

const pr = (number: number, overrides: Partial<WindowPr> = {}): WindowPr => ({
  number,
  title: `Add widget ${number}`,
  body: null,
  state: "MERGED",
  createdAt: day(number),
  mergedAt: day(number, 12),
  closedAt: day(number, 12),
  headRefName: `feat/widget-${number}`,
  baseRefName: "main",
  author: { login: "dev", is_bot: false },
  mergeCommit: { oid: `m${number}` },
  files: [`src/w${number}.ts`],
  reviews: [],
  comments: [],
  commits: [],
  ...overrides,
});

const commit = (oid: string, committedDate: string, messageHeadline = "Add code") => ({ oid, committedDate, messageHeadline });

describe("rework commits", () => {
  it("counts a commit after the first review and not one at the review instant (kills > turned >=)", () => {
    const reviewed = pr(1, {
      reviews: [{ state: "COMMENTED", submittedAt: day(1, 6) }],
      commits: [commit("a", day(1, 6)), commit("b", day(1, 7))],
    });
    expect(labelV2(reviewed, [reviewed])).toMatchObject({ post_review_commits: 1, rework_commits: 1 });
  });

  it("dates the first review from a review-shaped comment (kills dropping REVIEW_COMMENT_RE comments)", () => {
    const reviewed = pr(1, {
      comments: [{ createdAt: day(1, 3), body: "Thanks!" }, { createdAt: day(1, 5), body: "Verdict: FIX_FIRST" }],
      commits: [commit("a", day(1, 4)), commit("b", day(1, 6))],
    });
    expect(labelV2(reviewed, [reviewed]).post_review_commits).toBe(1);
  });

  it("counts a fixup! commit once even when it also follows the review (kills summing instead of a union)", () => {
    const reviewed = pr(1, {
      reviews: [{ state: "APPROVED", submittedAt: day(1, 2) }],
      commits: [commit("a", day(1, 1), "fixup! Add code"), commit("b", day(1, 3), "Address review nits")],
    });
    expect(labelV2(reviewed, [reviewed])).toMatchObject({ fixup_commits: 2, post_review_commits: 1, rework_commits: 2 });
    expect(labelV2(reviewed, [reviewed]).outcome).toBe("accepted_after_rework");
  });

  it("counts a changes-requested round only when a later commit answered it (kills dropping the last-commit bound)", () => {
    const reviewed = pr(1, {
      reviews: [
        { state: "CHANGES_REQUESTED", submittedAt: day(1, 2) },
        { state: "CHANGES_REQUESTED", submittedAt: day(1, 9) },
      ],
      commits: [commit("a", day(1, 1)), commit("b", day(1, 4))],
    });
    expect(changesRequestedRounds(reviewed)).toBe(1);
  });
});

describe("prior attempts", () => {
  it("credits a closed earlier attempt only to the PR that superseded it (kills dropping attributed_to, the v1 rule)", () => {
    const attempt = pr(1, { title: "Add widget (TP-9001)", state: "CLOSED", mergedAt: null, files: ["src/w.ts"] });
    const superseding = pr(2, { title: "Add widget again (TP-9001)", files: ["src/w.ts", "src/x.ts"] });
    const later = pr(3, { title: "Tidy widget (TP-9001)", files: ["src/w.ts"] });
    const window = [later, superseding, attempt];
    expect(labelV2(superseding, window)).toMatchObject({ prior_attempts: [1], rework_count: 1, outcome: "accepted_after_rework" });
    expect(labelV2(later, window)).toMatchObject({ prior_attempts: [], outcome: "accepted_first_pass" });
  });

  it("falls back to the branch when no merged PR overlaps the attempt (kills dropping the headRefName fallback)", () => {
    const attempt = pr(1, { state: "CLOSED", mergedAt: null, headRefName: "feat/same", files: ["a.ts"] });
    const retry = pr(2, { headRefName: "feat/same", files: ["b.ts"] });
    expect(labelV2(retry, [retry, attempt]).prior_attempts).toEqual([1]);
  });
});

describe("follow-up fixes", () => {
  const fixed = pr(1, { title: "Add widget (TP-9002)", files: ["src/w.ts"] });
  const other = pr(2, { title: "Add gadget (TP-9002)", files: ["src/g.ts"] });

  it("credits a fix inside 14 days only to the PR whose files it touches (kills dropping attributed_to)", () => {
    const fix = pr(10, { title: "fix: widget edge (TP-9002)", files: ["src/w.ts"] });
    const window = [fix, other, fixed];
    expect(labelV2(fixed, window).follow_up_fixes).toEqual([10]);
    expect(labelV2(other, window).follow_up_fixes).toEqual([]);
  });

  it("ignores a fix opened 20 days after the merge (kills 14 turned 30 days)", () => {
    const late = pr(21, { title: "fix: widget edge (TP-9002)", files: ["src/w.ts"] });
    expect(labelV2(fixed, [late, fixed]).follow_up_fixes).toEqual([]);
  });

  it("ignores a same-task PR whose title is not a fix (kills dropping FOLLOW_UP_TITLE_RE)", () => {
    const feature = pr(5, { title: "Extend widget (TP-9002)", files: ["src/w.ts"] });
    expect(labelV2(fixed, [feature, fixed]).follow_up_fixes).toEqual([]);
  });
});

describe("outcome", () => {
  it('calls a merged PR abandoned once a `Revert "<title>"` PR exists (kills dropping reverted_by)', () => {
    const merged = pr(1);
    const revert = pr(4, { title: 'Revert "Add widget 1"' });
    expect(labelV2(merged, [revert, merged])).toMatchObject({ reverted_by: 4, outcome: "abandoned" });
  });

  it("calls a clean merged PR accepted first pass and a closed one abandoned", () => {
    expect(labelV2(pr(1), [pr(1)]).outcome).toBe("accepted_first_pass");
    expect(labelV2(pr(2, { state: "CLOSED", mergedAt: null }), []).outcome).toBe("abandoned");
  });
});

describe("excludedReason", () => {
  it("excludes open, bot and release PRs (kills removing RELEASE_RE or the bot checks)", () => {
    expect(excludedReason(pr(1, { state: "OPEN" }))).toBe("open");
    expect(excludedReason(pr(1, { author: { login: "renovate[bot]", is_bot: false } }))).toBe("bot");
    expect(excludedReason(pr(1, { author: { login: "app", is_bot: true } }))).toBe("bot");
    expect(excludedReason(pr(1, { title: "Version Packages" }))).toBe("release");
    expect(excludedReason(pr(1, { title: "chore(deps): bump vite" }))).toBe("release");
    expect(excludedReason(pr(1, { title: "Add release notes page" }))).toBeNull();
  });
});

describe("pinWindow", () => {
  it("keeps the newest PRs created by as-of, reopening any closed after it (kills < on closedAt, dropping the limit)", () => {
    const window = pinWindow([pr(1), pr(2, { closedAt: day(3), mergedAt: day(3) }), pr(3), pr(4)], day(3), 2);
    expect(window.map((p) => [p.number, p.state, p.mergedAt])).toEqual([
      [3, "OPEN", null],
      [2, "MERGED", day(3)],
    ]);
  });
});

describe("v2Parity", () => {
  const merged = pr(1);
  const stored = (overrides: Partial<StoredCase> = {}): StoredCase => ({
    case_id: "widgets#1",
    repo: "widgets",
    pr_number: 1,
    ...labelV2(merged, [merged]),
    ...overrides,
  });

  it("reports the case and field of one planted label change outside outcome (kills comparing outcome alone)", () => {
    const report = v2Parity({ widgets: [merged] }, [stored({ reverted_by: 9 })]);
    expect(report).toEqual({ cases: 1, mismatches: [{ case_id: "widgets#1", field: "reverted_by" }], missing: [] });
  });

  it("lists a stored case with no PR in the window as missing input, not a mismatch", () => {
    expect(v2Parity({}, [stored()])).toEqual({ cases: 1, mismatches: [], missing: ["widgets#1"] });
  });
});

describe("loadWindow", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = "repos/acme/widgets";
  const write = (path: string, data: unknown): void => writeFileSync(join(dir, cacheFileName(path)), JSON.stringify(data));
  const restPull = (number: number, state: string, mergedAt: string | null, login = "dev") => ({
    number,
    title: `Add widget ${number}`,
    body: null,
    state,
    created_at: day(number),
    merged_at: mergedAt,
    closed_at: mergedAt,
    head: { ref: `feat/w${number}` },
    base: { ref: "main" },
    user: { login, type: "User" },
    merge_commit_sha: mergedAt ? `m${number}` : null,
  });

  const seedCache = (): void => {
    dir = mkdtempSync(join(tmpdir(), "label-v2-"));
    write(`${base}/pulls?state=all&sort=created&direction=desc&per_page=100`, [
      restPull(2, "closed", null, "renovate[bot]"),
      restPull(1, "closed", day(1, 6)),
    ]);
    for (const n of [1, 2]) write(`${base}/pulls/${n}/files?per_page=100`, [{ filename: `src/w${n}.ts` }]);
    write(`${base}/pulls/1`, { additions: 3, deletions: 1, changed_files: 1 });
    write(`${base}/pulls/1/reviews?per_page=100`, [{ state: "APPROVED", submitted_at: day(1, 2) }]);
    write(`${base}/issues/1/comments?per_page=100`, []);
    write(`${base}/pulls/1/commits?per_page=100`, [{ sha: "c1", commit: { message: "Add code\n\nbody", committer: { date: day(1, 1) } } }]);
  };

  it("maps cached REST JSON to window PRs and reads details only for would-be cases", () => {
    seedCache();
    const [bot, kept] = loadWindow(dir, { owner: "acme", repo: "widgets", asOf: day(5) });
    expect(bot).toMatchObject({ number: 2, state: "CLOSED", files: ["src/w2.ts"] });
    expect(bot?.commits).toBeUndefined();
    expect(kept).toMatchObject({ state: "MERGED", mergeCommit: { oid: "m1" }, changedFiles: 1 });
    expect(kept?.commits).toEqual([{ oid: "c1", committedDate: day(1, 1), messageHeadline: "Add code" }]);
  });

  it("fails on a missing cache file instead of fetching it", () => {
    seedCache();
    rmSync(join(dir, cacheFileName(`${base}/pulls/1/reviews?per_page=100`)));
    expect(() => loadWindow(dir, { owner: "acme", repo: "widgets", asOf: day(5) })).toThrow(/never fetches/);
  });
});
