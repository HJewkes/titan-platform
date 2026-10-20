import { describe, expect, it } from "vitest";
import { SOURCES_MODES } from "../github-sources/mode.js";
import type { CiKeyFn } from "./ci-keys.js";
import type { CiFact } from "../test-support/a17/ci-shapes.js";
import { openFeed, type A17Mode, type Feed, type Step } from "../test-support/a17/feed.js";
import { a17Event } from "../test-support/a17/register.js";

/** What a fixture observes: the row count, the waiter's final read, and (where the table names them) earlier reads and append results. */
interface Outcome {
  rows: number;
  waiter: string[];
  early?: string[];
  by?: Step[];
}

interface Fixture {
  id: string;
  /** The recorded payload or documentation example the wire shapes follow. */
  from: string;
  /** Writes the scenario once; facts the poller cannot see are declared with `transient`. */
  run: (feed: Feed) => Outcome;
  expect: Record<A17Mode, Outcome>;
}

const A = "a".repeat(40);
const B = "b".repeat(40);
const STATUS_DOC = "GitHub webhook events docs, `status` example, with the StatusCheckRollup StatusContext node";
const CHECK_DOC = "GitHub webhook events docs, `check_run` completed example, with the StatusCheckRollup CheckRun node";
const fact = (over: Partial<CiFact> = {}): CiFact => ({ type: "status", repo: "o/r", head: A, context: "ci", outcome: "success", at: "2026-10-17T10:00:00Z", ...over });
const run = (id: number, over: Partial<CiFact> = {}): CiFact => fact({ type: "check", checkRunId: id, context: "build", ...over });

const label = (row: { subject: string; keys: Record<string, unknown>; sourceAt: string | null }): string =>
  `${row.subject.replace(/([ab])\1{39}/, "$1")}:${String(row.keys.outcome)}@${row.sourceAt?.slice(11, 16)}`;
const read = (feed: Feed, subject: string, since: number): string[] => feed.read(subject, since).map(label);
const finish = (feed: Feed, subject: string, since: number, extra: Partial<Outcome> = {}): Outcome => ({ rows: feed.headSeq(), waiter: read(feed, subject, since), ...extra });
const both = (outcome: Outcome): Record<A17Mode, Outcome> => ({ webhook: outcome, polling: outcome });

const SUCCESS_FAILURE_SUCCESS = ["o/r@a:success@10:00", "o/r@a:failure@10:01", "o/r@a:success@10:02"];
const SUCCESS_SUCCESS = ["o/r@a:success@10:00", "o/r@a:success@10:02"];

function threeStatuses(): [CiFact, CiFact, CiFact] {
  return [fact({ at: "2026-10-17T10:00:00Z" }), fact({ outcome: "failure", at: "2026-10-17T10:01:00Z" }), fact({ at: "2026-10-17T10:02:00Z" })];
}

function checkReruns(): [CiFact, CiFact, CiFact] {
  return [run(101, { at: "2026-10-17T10:00:00Z" }), run(102, { outcome: "failure", at: "2026-10-17T10:01:00Z" }), run(103, { at: "2026-10-17T10:02:00Z" })];
}

/** The failure holds between two polls, so only a delivery sees it. */
function successFailureSuccess(feed: Feed, [first, failure, second]: [CiFact, CiFact, CiFact]): void {
  feed.fact(first);
  feed.transient(failure);
  feed.fact(second);
}

const FIXTURES: Fixture[] = [
  {
    id: "F1 different head",
    from: STATUS_DOC,
    run: (feed) => {
      feed.fact(fact({ head: A }));
      const since = feed.headSeq();
      feed.fact(fact({ head: B, at: "2026-10-17T10:05:00Z" }));
      return finish(feed, `o/r@${B}`, since);
    },
    expect: both({ rows: 2, waiter: ["o/r@b:success@10:05"] }),
  },
  {
    id: "F2 different repo",
    from: STATUS_DOC,
    run: (feed) => {
      feed.fact(fact({ repo: "o/x" }));
      feed.fact(fact({ repo: "o/y" }));
      return finish(feed, `o/y@${A}`, 0);
    },
    expect: both({ rows: 2, waiter: ["o/y@a:success@10:00"] }),
  },
  {
    id: "F3 duplicate delivery",
    from: STATUS_DOC,
    run: (feed) => {
      const by = [...feed.fact(fact(), { deliveryId: "d1" }), ...feed.fact(fact(), { deliveryId: "d1" })];
      return finish(feed, `o/r@${A}`, feed.headSeq(), { by });
    },
    expect: {
      webhook: { rows: 1, waiter: [], by: ["inserted", "occurrence", "delivery", "occurrence"] },
      polling: { rows: 1, waiter: [], by: ["inserted", "occurrence"] },
    },
  },
  {
    id: "F4 success, failure, success on one head",
    from: STATUS_DOC,
    run: (feed) => {
      successFailureSuccess(feed, threeStatuses());
      return finish(feed, `o/r@${A}`, 0);
    },
    expect: { webhook: { rows: 3, waiter: SUCCESS_FAILURE_SUCCESS }, polling: { rows: 2, waiter: SUCCESS_SUCCESS } },
  },
  {
    id: "F4c success, failure, success as check re-runs",
    from: CHECK_DOC,
    run: (feed) => {
      successFailureSuccess(feed, checkReruns());
      return finish(feed, `o/r@${A}`, 0);
    },
    expect: { webhook: { rows: 3, waiter: SUCCESS_FAILURE_SUCCESS }, polling: { rows: 2, waiter: SUCCESS_SUCCESS } },
  },
  {
    id: "F4p success, failure, success held across polls",
    from: STATUS_DOC,
    run: (feed) => {
      threeStatuses().forEach((f) => feed.fact(f));
      return finish(feed, `o/r@${A}`, 0);
    },
    expect: both({ rows: 3, waiter: SUCCESS_FAILURE_SUCCESS }),
  },
  {
    id: "F5 waiter between transitions",
    from: STATUS_DOC,
    run: (feed) => {
      const [first, failure, second] = threeStatuses();
      feed.fact(first);
      feed.transient(failure);
      const since = feed.headSeq();
      const early = read(feed, `o/r@${A}`, since);
      feed.fact(second);
      return finish(feed, `o/r@${A}`, since, { early });
    },
    expect: { webhook: { rows: 3, early: [], waiter: ["o/r@a:success@10:02"] }, polling: { rows: 2, early: [], waiter: ["o/r@a:success@10:02"] } },
  },
  {
    id: "F5b lookback",
    from: STATUS_DOC,
    run: (feed) => {
      const [first, failure, second] = threeStatuses();
      [first, failure].forEach((f) => feed.fact(f));
      const since = feed.headSeq();
      feed.fact(second);
      return finish(feed, `o/r@${A}`, since);
    },
    expect: both({ rows: 3, waiter: ["o/r@a:success@10:02"] }),
  },
  {
    id: "F8 same state re-posted in one second",
    from: STATUS_DOC,
    run: (feed) => {
      feed.fact(fact());
      feed.fact(fact());
      return finish(feed, `o/r@${A}`, 0);
    },
    expect: both({ rows: 1, waiter: ["o/r@a:success@10:00"] }),
  },
];

/** The plan's literal contract: the key names only the check or context and its state. */
const contextOnlyKey: CiKeyFn = (o) => `CIConcluded|${o.context}|${o.outcome}`;

describe("CIConcluded dual-mode truth table", () => {
  it("names the recorded payload or documentation example behind every fixture", () => {
    expect(FIXTURES.filter((f) => f.from.trim() === "")).toEqual([]);
  });

  for (const f of FIXTURES) a17Event(`CIConcluded ${f.id}`, (feed) => expect(f.run(feed)).toEqual(feed.pick(f.expect)));
});

describe("CIConcluded truth table under the literal context-only key", () => {
  const MUST_FAIL = /^(F1|F2|F4 |F4p|F5)/;
  const cases = (key: CiKeyFn) => FIXTURES.filter((f) => MUST_FAIL.test(f.id)).flatMap((f) => SOURCES_MODES.map((mode) => ({ name: `${f.id} / ${mode}`, f, mode, key })));

  it.each(cases(contextOnlyKey))("$name no longer matches the table", ({ f, mode, key }) => {
    expect(f.run(openFeed(mode, key))).not.toEqual(f.expect[mode]);
  });

  it("covers F1, F2, F4 and F5 in both modes", () => {
    expect(cases(contextOnlyKey).map((c) => c.name)).toEqual(expect.arrayContaining(["F1 different head / webhook", "F2 different repo / polling", "F4 success, failure, success on one head / webhook", "F5 waiter between transitions / polling"]));
  });
});
