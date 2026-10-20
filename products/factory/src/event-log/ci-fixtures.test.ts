import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { ciEvent, ciKey, fromBackstopContext, fromCheckRunDelivery, fromStatusDelivery, type CiKeyFn } from "./ci-keys.js";
import { backstopNode, checkRunDelivery, statusDelivery, type CiFact } from "./ci-shapes.test-helpers.js";
import { appendEvent, eventLogMigration, headSeq, readEvents } from "./event-log.js";

type Mode = "webhook" | "polling";
type Step = "inserted" | "delivery" | "occurrence";

/** What a fixture observes: the row count, the waiter's final read, and (where the table names them) earlier reads and append results. */
interface Outcome {
  rows: number;
  waiter: string[];
  early?: string[];
  by?: Step[];
}

interface Harness {
  mode: Mode;
  db: Db;
  key: CiKeyFn;
  /** Both sources report the fact; polling alone sees the backstop. */
  witness: (fact: CiFact) => void;
  deliver: (fact: CiFact, deliveryId: string) => Step;
  observe: (fact: CiFact) => Step;
  read: (subject: string, since: number) => string[];
}

interface Fixture {
  id: string;
  /** The recorded payload or documentation example the wire shapes follow. */
  from: string;
  run: (h: Harness) => Outcome;
  expect: Partial<Record<Mode, Outcome>>;
}

const MODES: Mode[] = ["webhook", "polling"];
const A = "a".repeat(40);
const B = "b".repeat(40);
const STATUS_DOC = "GitHub webhook events docs, `status` example, with the StatusCheckRollup StatusContext node";
const CHECK_DOC = "GitHub webhook events docs, `check_run` completed example, with the StatusCheckRollup CheckRun node";
const fact = (over: Partial<CiFact> = {}): CiFact => ({ type: "status", repo: "o/r", head: A, context: "ci", outcome: "success", at: "2026-10-17T10:00:00Z", ...over });
const run = (id: number, over: Partial<CiFact> = {}): CiFact => fact({ type: "check", checkRunId: id, context: "build", ...over });

const stepOf = (result: ReturnType<typeof appendEvent>): Step => (result.inserted ? "inserted" : result.by === "unchanged" ? "occurrence" : result.by);
const label = (row: { subject: string; keys: Record<string, unknown>; sourceAt: string | null }): string =>
  `${row.subject.replace(/([ab])\1{39}/, "$1")}:${String(row.keys.outcome)}@${row.sourceAt?.slice(11, 16)}`;

function harness(mode: Mode, key: CiKeyFn): Harness {
  const db = openDatabase(":memory:");
  runMigrations(db, [eventLogMigration()]);
  const observed = "2026-10-17T12:00:00.000Z";
  const observation = (f: CiFact, viaWebhook: boolean) =>
    viaWebhook
      ? f.type === "check" ? fromCheckRunDelivery(checkRunDelivery(f)) : fromStatusDelivery(statusDelivery(f))
      : fromBackstopContext(f.repo, f.head, backstopNode(f));
  const emit = (f: CiFact, deliveryId?: string): Step => {
    const seen = observation(f, deliveryId !== undefined);
    if (seen === undefined) throw new Error("fixture fact is not an occurrence");
    const transport = deliveryId === undefined ? ({ source: "backstop", observedAt: observed } as const) : ({ source: "webhook", observedAt: observed, deliveryId } as const);
    return stepOf(appendEvent(db, ciEvent(seen, transport, key)));
  };
  let delivery = 0;
  return {
    mode,
    db,
    key,
    deliver: (f, id) => emit(f, id),
    observe: (f) => emit(f),
    witness: (f) => {
      if (mode === "webhook") emit(f, `auto-${++delivery}`);
      emit(f);
    },
    read: (subject, since) => readEvents(db, { subject, sinceSeq: since }).map(label),
  };
}

const total = (h: Harness): number => headSeq(h.db);
const finish = (h: Harness, subject: string, since: number, extra: Partial<Outcome> = {}): Outcome => ({ rows: total(h), waiter: h.read(subject, since), ...extra });

const FIXTURES: Fixture[] = [
  {
    id: "F1 different head",
    from: STATUS_DOC,
    run: (h) => {
      h.witness(fact({ head: A }));
      const since = headSeq(h.db);
      h.witness(fact({ head: B, at: "2026-10-17T10:05:00Z" }));
      return finish(h, `o/r@${B}`, since);
    },
    expect: { webhook: { rows: 2, waiter: ["o/r@b:success@10:05"] }, polling: { rows: 2, waiter: ["o/r@b:success@10:05"] } },
  },
  {
    id: "F2 different repo",
    from: STATUS_DOC,
    run: (h) => {
      h.witness(fact({ repo: "o/x" }));
      h.witness(fact({ repo: "o/y" }));
      return finish(h, `o/y@${A}`, 0);
    },
    expect: { webhook: { rows: 2, waiter: ["o/y@a:success@10:00"] }, polling: { rows: 2, waiter: ["o/y@a:success@10:00"] } },
  },
  {
    id: "F3 duplicate delivery",
    from: STATUS_DOC,
    run: (h) => {
      const by = h.mode === "webhook" ? [h.deliver(fact(), "d1"), h.deliver(fact(), "d1"), h.observe(fact())] : [h.observe(fact()), h.observe(fact())];
      return finish(h, `o/r@${A}`, headSeq(h.db), { by });
    },
    expect: {
      webhook: { rows: 1, waiter: [], by: ["inserted", "delivery", "occurrence"] },
      polling: { rows: 1, waiter: [], by: ["inserted", "occurrence"] },
    },
  },
  {
    id: "F4 success, failure, success on one head",
    from: STATUS_DOC,
    run: (h) => {
      threeStatuses().forEach((f) => h.witness(f));
      return finish(h, `o/r@${A}`, 0);
    },
    expect: { webhook: { rows: 3, waiter: ["o/r@a:success@10:00", "o/r@a:failure@10:01", "o/r@a:success@10:02"] }, polling: { rows: 3, waiter: ["o/r@a:success@10:00", "o/r@a:failure@10:01", "o/r@a:success@10:02"] } },
  },
  {
    id: "F4 polling with the failure missed",
    from: STATUS_DOC,
    run: (h) => {
      const [first, , second] = threeStatuses();
      [first, second].forEach((f) => h.witness(f));
      return finish(h, `o/r@${A}`, 0);
    },
    expect: { polling: { rows: 2, waiter: ["o/r@a:success@10:00", "o/r@a:success@10:02"] } },
  },
  {
    id: "F4c success, failure, success as check re-runs",
    from: CHECK_DOC,
    run: (h) => {
      checkReruns().forEach((f) => h.witness(f));
      return finish(h, `o/r@${A}`, 0);
    },
    expect: { webhook: { rows: 3, waiter: ["o/r@a:success@10:00", "o/r@a:failure@10:01", "o/r@a:success@10:02"] }, polling: { rows: 3, waiter: ["o/r@a:success@10:00", "o/r@a:failure@10:01", "o/r@a:success@10:02"] } },
  },
  {
    id: "F4c polling with the failure missed",
    from: CHECK_DOC,
    run: (h) => {
      const [first, , second] = checkReruns();
      [first, second].forEach((f) => h.witness(f));
      return finish(h, `o/r@${A}`, 0);
    },
    expect: { polling: { rows: 2, waiter: ["o/r@a:success@10:00", "o/r@a:success@10:02"] } },
  },
  {
    id: "F5 waiter between transitions",
    from: STATUS_DOC,
    run: (h) => {
      const [first, failure, second] = threeStatuses();
      h.witness(first);
      h.witness(failure);
      const since = headSeq(h.db);
      const early = h.read(`o/r@${A}`, since);
      h.witness(second);
      return finish(h, `o/r@${A}`, since, { early });
    },
    expect: { webhook: { rows: 3, early: [], waiter: ["o/r@a:success@10:02"] } },
  },
  {
    id: "F5 polling, the waiter learned the failure by a live read",
    from: STATUS_DOC,
    run: (h) => {
      const [first, , second] = threeStatuses();
      h.witness(first);
      const since = headSeq(h.db);
      const early = h.read(`o/r@${A}`, since);
      h.witness(second);
      return finish(h, `o/r@${A}`, since, { early });
    },
    expect: { polling: { rows: 2, early: [], waiter: ["o/r@a:success@10:02"] } },
  },
  {
    id: "F5b lookback",
    from: STATUS_DOC,
    run: (h) => {
      const [first, failure, second] = threeStatuses();
      [first, failure].forEach((f) => h.witness(f));
      const since = headSeq(h.db);
      h.witness(second);
      return finish(h, `o/r@${A}`, since);
    },
    expect: { webhook: { rows: 3, waiter: ["o/r@a:success@10:02"] }, polling: { rows: 3, waiter: ["o/r@a:success@10:02"] } },
  },
  {
    id: "F8 same state re-posted in one second",
    from: STATUS_DOC,
    run: (h) => {
      h.witness(fact());
      h.witness(fact());
      return finish(h, `o/r@${A}`, 0);
    },
    expect: { webhook: { rows: 1, waiter: ["o/r@a:success@10:00"] }, polling: { rows: 1, waiter: ["o/r@a:success@10:00"] } },
  },
];

function threeStatuses(): [CiFact, CiFact, CiFact] {
  return [fact({ at: "2026-10-17T10:00:00Z" }), fact({ outcome: "failure", at: "2026-10-17T10:01:00Z" }), fact({ at: "2026-10-17T10:02:00Z" })];
}

function checkReruns(): [CiFact, CiFact, CiFact] {
  return [run(101, { at: "2026-10-17T10:00:00Z" }), run(102, { outcome: "failure", at: "2026-10-17T10:01:00Z" }), run(103, { at: "2026-10-17T10:02:00Z" })];
}

/** The plan's literal contract: the key names only the check or context and its state. */
const contextOnlyKey: CiKeyFn = (o) => `CIConcluded|${o.context}|${o.outcome}`;

const cases = (key: CiKeyFn, only?: RegExp) =>
  FIXTURES.filter((f) => only === undefined || only.test(f.id)).flatMap((f) =>
    MODES.flatMap((mode) => {
      const expected = f.expect[mode];
      return expected === undefined ? [] : [{ name: `${f.id} / ${mode}`, f, mode, key, expected }];
    }),
  );

describe("CIConcluded dual-mode truth table", () => {
  it("names the recorded payload or documentation example behind every fixture", () => {
    expect(FIXTURES.filter((f) => f.from.trim() === "")).toEqual([]);
  });

  it.each(cases(ciKey))("$name", ({ f, mode, key, expected }) => {
    expect(f.run(harness(mode, key))).toEqual(expected);
  });
});

describe("CIConcluded truth table under the literal context-only key", () => {
  const MUST_FAIL = /^(F1|F2|F4 |F4 polling|F5)/;

  it.each(cases(contextOnlyKey, MUST_FAIL))("$name no longer matches the table", ({ f, mode, key, expected }) => {
    expect(f.run(harness(mode, key))).not.toEqual(expected);
  });

  it("covers F1, F2, F4 and F5 in both modes where the table has them", () => {
    const ids = cases(contextOnlyKey, MUST_FAIL).map((c) => c.name);

    expect(ids).toEqual(expect.arrayContaining(["F1 different head / webhook", "F2 different repo / polling", "F4 success, failure, success on one head / webhook", "F5 waiter between transitions / webhook"]));
  });
});
