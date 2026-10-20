import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { appendEvent, eventLogMigration, headSeq, readEvents, type IdentityEvent, type TransitionEvent } from "./event-log.js";
import { fromBackstopMain, fromBackstopOpenPr, fromPullRequestDelivery, fromPushDelivery, repoEvent, type RepoObservation } from "./repo-keys.js";
import { backstopOpenPr, pullRequestDelivery, pushDelivery } from "./repo-shapes.test-helpers.js";

type Mode = "webhook" | "polling";
type Step = "inserted" | "delivery" | "occurrence" | "unchanged";
type Event = IdentityEvent | TransitionEvent;

/** One transition kind: its subject, and how each source reports the subject holding `value`. */
interface Driver {
  kind: "HeadPushed" | "BaseChanged" | "MainMoved";
  subject: string;
  from: string;
  webhook: (value: string) => RepoObservation[];
  backstop: (value: string) => RepoObservation[];
}

const pr = (over: { head?: string; base?: string }) => ({ repo: "o/r", pr: 1, head: over.head ?? "h".repeat(40), base: over.base ?? "main" });
const just = (o: RepoObservation | undefined): RepoObservation[] => (o === undefined ? [] : [o]);

const DRIVERS: Driver[] = [
  {
    kind: "HeadPushed",
    subject: "o/r#1",
    from: "GitHub webhook events docs, `pull_request` synchronize example, with the backstop's GhOpenPr node",
    webhook: (sha) => fromPullRequestDelivery(pullRequestDelivery(pr({ head: sha }))),
    backstop: (sha) => fromBackstopOpenPr("o/r", backstopOpenPr(pr({ head: sha }))),
  },
  {
    kind: "BaseChanged",
    subject: "o/r#1",
    from: "GitHub webhook events docs, `pull_request` edited example, with the backstop's GhOpenPr node",
    webhook: (ref) => fromPullRequestDelivery(pullRequestDelivery(pr({ base: ref }), "edited")),
    backstop: (ref) => fromBackstopOpenPr("o/r", backstopOpenPr(pr({ base: ref }))),
  },
  {
    kind: "MainMoved",
    subject: "o/r:main",
    from: "GitHub webhook events docs, `push` example, with the backstop's history ref target",
    webhook: (sha) => just(fromPushDelivery(pushDelivery("o/r", "main", sha))),
    backstop: (sha) => [fromBackstopMain("o/r", "main", sha)],
  },
];

/** The literal contract: (subject, value) unique, as if a return to an earlier value were a duplicate. */
const literal = (event: Event): Event => (event.rule === "transition" ? { ...event, rule: "identity", occurrenceKey: event.keyBase, keys: { value: event.value } } : event);

interface Harness {
  db: Db;
  /** Both sources report the value; polling alone sees the backstop. Returns the driver kind's append result. */
  witness: (value: string) => Step;
  /** A webhook delivery only, with its own id. */
  deliver: (value: string) => Step;
  /** One backstop tick only. */
  observe: (value: string) => Step;
  /** The driver kind's values above `since`, each shortened to its first character. */
  read: (since?: number) => string[];
}

function harness(mode: Mode, driver: Driver, db: Db, mutate: (e: Event) => Event = (e) => e): Harness {
  const observedAt = "2026-10-17T12:00:00.000Z";
  let delivery = 0;
  const emit = (observations: RepoObservation[], deliveryId?: string): Step => {
    const transport = deliveryId === undefined ? ({ source: "backstop", observedAt } as const) : ({ source: "webhook", observedAt, deliveryId } as const);
    const steps = observations.map((o) => ({ kind: o.kind, result: appendEvent(db, mutate(repoEvent(o, transport))) }));
    const mine = steps.find((s) => s.kind === driver.kind)?.result;
    if (mine === undefined) throw new Error(`the fixture yielded no ${driver.kind}`);
    return mine.inserted ? "inserted" : mine.by;
  };
  const deliver = (value: string) => emit(driver.webhook(value), `${mode}-${++delivery}`);
  const observe = (value: string) => emit(driver.backstop(value));
  return {
    db,
    deliver,
    observe,
    witness: (value) => (mode === "webhook" ? [deliver(value), observe(value)][0]! : observe(value)),
    read: (since = 0) => readEvents(db, { subject: driver.subject, kind: driver.kind, sinceSeq: since }).map((row) => String(row.keys.value).slice(0, 1)),
  };
}

function freshDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [eventLogMigration()]);
  return db;
}

const A = "a".repeat(40);
const B = "b".repeat(40);
const value = (driver: Driver, short: "a" | "b"): string => (driver.kind === "BaseChanged" ? `${short}-base` : short === "a" ? A : B);

/** F6: head A -> B -> A gives three rows, and a waiter that captured the log after B reads the return to A. */
function f6(mode: Mode, driver: Driver, mutate?: (e: Event) => Event) {
  const h = harness(mode, driver, freshDb(), mutate);
  h.witness(value(driver, "a"));
  h.witness(value(driver, "b"));
  const since = headSeq(h.db);
  h.witness(value(driver, "a"));
  return { rows: h.read(), waiter: h.read(since) };
}

/** F7: a late, distinct report of an older value adds at most one row and leaves every earlier row in place. */
function f7(mode: Mode, driver: Driver) {
  const h = harness(mode, driver, freshDb());
  const report = mode === "webhook" ? h.deliver : h.observe;
  report(value(driver, "a"));
  report(value(driver, "b"));
  const before = h.read();
  const late = report(value(driver, "a"));
  const after = h.read();
  return { late, added: after.length - before.length, kept: after.slice(0, before.length) };
}

/** F9: the poller restarts with no memory; seeing the value the log already holds inserts nothing. */
function f9(mode: Mode, driver: Driver) {
  const db = freshDb();
  harness(mode, driver, db).witness(value(driver, "b"));
  const restarted = harness(mode, driver, db);
  return { tick: restarted.observe(value(driver, "b")), rows: restarted.read() };
}

const MODES: Mode[] = ["webhook", "polling"];
const cases = MODES.flatMap((mode) => DRIVERS.map((driver) => ({ name: `${driver.kind} / ${mode}`, mode, driver })));

describe("transition-kind dual-mode truth table", () => {
  it("names the documentation example behind every driver", () => {
    expect(DRIVERS.filter((d) => d.from.trim() === "")).toEqual([]);
  });

  it.each(cases)("F6 A -> B -> A: $name", ({ mode, driver }) => {
    expect(f6(mode, driver)).toEqual({ rows: ["a", "b", "a"], waiter: ["a"] });
  });

  it.each(cases)("F7 a late reordered report: $name", ({ mode, driver }) => {
    expect(f7(mode, driver)).toEqual({ late: "inserted", added: 1, kept: ["a", "b"] });
  });

  it.each(cases)("F9 a restarted poller sees an unchanged value: $name", ({ mode, driver }) => {
    expect(f9(mode, driver)).toEqual({ tick: "unchanged", rows: ["b"] });
  });
});

describe("transition kinds under the literal (subject, value) key", () => {
  it.each(cases)("F6 loses the return to A: $name", ({ mode, driver }) => {
    expect(f6(mode, driver, literal)).toEqual({ rows: ["a", "b"], waiter: [] });
  });
});
