/**
 * Whether a session holds an agent's name. `agent ls --json` reports `live`, `detached` and `exited`; `exiting` is the
 * short stretch while a session closes, and `deregistered` is the broker's word for a name with no row at all.
 */
const PRESENCES = ["live", "detached", "exiting", "exited", "deregistered"] as const;
export type Presence = (typeof PRESENCES)[number];

const KNOWN: ReadonlySet<string> = new Set(PRESENCES);

/** A value the roster reports that this list does not know counts as `live`, as every comparison treated it before: not gone. */
export function toPresence(value: string): Presence {
  return KNOWN.has(value) ? (value as Presence) : "live";
}
