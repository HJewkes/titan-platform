/**
 * Whether a session holds an agent's name. `agent ls --json` reports `live`, `detached` and `exited`; `exiting` is the
 * short stretch while a session closes, `deregistered` is the broker's word for a name with no row at all, and `unknown`
 * is any other value the roster reports.
 */
const PRESENCES = ["live", "detached", "exiting", "exited", "deregistered", "unknown"] as const;
export type Presence = (typeof PRESENCES)[number];

const KNOWN: ReadonlySet<string> = new Set(PRESENCES);

/**
 * An unlisted value becomes `unknown`, which no comparison treats as `exited`, `detached` or `deregistered`. The reader's
 * running set leaves it out too, so a partial last record from such an agent is damage, as it was when the value was a bare string.
 */
export function toPresence(value: string): Presence {
  return KNOWN.has(value) ? (value as Presence) : "unknown";
}
