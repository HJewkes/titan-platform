import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { ciEvent, ciKey, fromBackstopContext, fromCheckRunDelivery, fromStatusDelivery, type CiKeyFn } from "../../event-log/ci-keys.js";
import { appendEvent, headSeq, readEvents } from "../../event-log/event-log.js";
import { factoryMigrations } from "../../host.js";
import { resolveSources, type SOURCES_MODES } from "../../github-sources/mode.js";
import { backstopNode, checkRunDelivery, statusDelivery, type CiFact } from "./ci-shapes.js";

export type A17Mode = (typeof SOURCES_MODES)[number];

/** How an append resolved: a new row, a repeat of a delivery id, or a repeat of the occurrence. */
export type Step = "inserted" | "delivery" | "occurrence";

/**
 * What an A17 case sees of GitHub. It has no `mode` field: a case writes its scenario once as facts on a timeline and the
 * feed turns them into the mode's observations. Where the modes must differ, `pick` makes both answers explicit.
 */
export interface Feed {
  db: Db;
  /** Epoch milliseconds of the fake clock; moves only by `advance`. */
  now(): number;
  /** Moves the fake clock by `ms`, or by one reconciler interval of the mode. */
  advance(ms?: number): void;
  /** A state that holds across a reconciler tick. Webhook: delivered, then re-observed by the backstop. Polling: observed at the tick. */
  fact(fact: CiFact, options?: { deliveryId?: string }): Step[];
  /** A state that holds between two ticks only. Webhook: delivered, so a row exists. Polling: never observed. */
  transient(fact: CiFact): Step[];
  read(subject: string, sinceSeq: number): ReturnType<typeof readEvents>;
  headSeq(): number;
  /** The expectation for each mode, both required; the one way a case may state a divergence the modes are declared to have. */
  pick<T>(byMode: Record<A17Mode, T>): T;
}

const EPOCH = Date.parse("2026-10-17T12:00:00.000Z");

const stepOf = (result: ReturnType<typeof appendEvent>): Step => (result.inserted ? "inserted" : result.by === "unchanged" ? "occurrence" : result.by);

function sourcesConfig(mode: A17Mode) {
  const resolved = resolveSources({ github: mode === "webhook" ? { sources: "webhook", ingress: "on" } : { sources: "polling" } });
  if (resolved.effective !== mode) throw new Error(`harness config resolved to ${resolved.effective}, not ${mode}`);
  return resolved;
}

export function openFeed(mode: A17Mode, key: CiKeyFn = ciKey): Feed {
  const { intervalMs } = sourcesConfig(mode);
  const db = openDatabase(":memory:");
  runMigrations(db, factoryMigrations());
  let clock = EPOCH;
  let deliveries = 0;

  const emit = (f: CiFact, via: "webhook" | "backstop", deliveryId = `auto-${++deliveries}`): Step => {
    const seen =
      via === "webhook"
        ? f.type === "check" ? fromCheckRunDelivery(checkRunDelivery(f)) : fromStatusDelivery(statusDelivery(f))
        : fromBackstopContext(f.repo, f.head, backstopNode(f));
    if (seen === undefined) throw new Error("fixture fact is not an occurrence");
    const observedAt = new Date(clock).toISOString();
    const transport = via === "webhook" ? ({ source: "webhook", observedAt, deliveryId } as const) : ({ source: "backstop", observedAt } as const);
    return stepOf(appendEvent(db, ciEvent(seen, transport, key)));
  };

  return {
    db,
    now: () => clock,
    advance: (ms = intervalMs) => {
      clock += ms;
    },
    fact: (f, options) => (mode === "webhook" ? [emit(f, "webhook", options?.deliveryId), emit(f, "backstop")] : [emit(f, "backstop")]),
    transient: (f) => (mode === "webhook" ? [emit(f, "webhook")] : []),
    read: (subject, sinceSeq) => readEvents(db, { subject, sinceSeq }),
    headSeq: () => headSeq(db),
    pick: (byMode) => byMode[mode],
  };
}
