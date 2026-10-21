import type { CallClass } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { appendEvent } from "../event-log/event-log.js";

const API_AVAILABLE = "ApiAvailable";

/** The identity rule (TP-3095 §2): one reopen of one (identity, class) is one occurrence, keyed by its trip's resetAt. */
export function apiAvailableKey(identity: string, callClass: CallClass, resetAt: number): string {
  return `v1|${API_AVAILABLE}|${identity}|${callClass}|${Math.floor(resetAt / 1000)}`;
}

/** Appends one `ApiAvailable` for a reopened pair; a repeat for the same reopen inserts nothing. */
export function appendApiAvailable(db: Db, identity: string, callClass: CallClass, resetAt: number, observedAt: Date): ReturnType<typeof appendEvent> {
  return appendEvent(db, {
    rule: "identity",
    source: "store",
    kind: API_AVAILABLE,
    subject: identity,
    keys: { identity, class: callClass, resetAt },
    occurrenceKey: apiAvailableKey(identity, callClass, resetAt),
    observedAt: observedAt.toISOString(),
    payload: { identity, class: callClass, resetAt: new Date(resetAt).toISOString() },
  });
}

/** The pool's `onAvailable`. */
export function apiAvailableEmitter(db: Db, now: () => number = Date.now): (identity: string, callClass: CallClass, resetAt: number) => void {
  return (identity, callClass, resetAt) => void appendApiAvailable(db, identity, callClass, resetAt, new Date(now()));
}
