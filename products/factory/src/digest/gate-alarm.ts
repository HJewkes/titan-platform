import type { FrictionDay } from "../shepherd/owner-friction.js";
import type { WaitingGate } from "../shepherd/waiting.js";

export const MEDIAN_ALARM_HOURS = 24;
export const GATE_ALARM_HOURS = 72;
const OLDEST_LISTED = 5;
const APPROVE_MERGE = "approve-merge";

export interface GateAlarm {
  /** The approve-merge median wait; absent when the friction row has none. */
  medianHours?: number;
  over72: WaitingGate[];
  /** Every gate past 72 h; when only the median fired, the oldest owner gates instead. */
  listed: WaitingGate[];
}

/** Both thresholds are strict: a wait of exactly 24 h or 72 h does not alarm. `ownerGates` is oldest first. */
export function gateAlarm(friction: FrictionDay | undefined, ownerGates: readonly WaitingGate[]): GateAlarm | undefined {
  const medianHours = friction?.kinds.find((k) => k.kind === APPROVE_MERGE)?.medianHours;
  const over72 = ownerGates.filter((g) => g.ageHours > GATE_ALARM_HOURS);
  const medianFired = medianHours !== undefined && medianHours > MEDIAN_ALARM_HOURS;
  if (!medianFired && over72.length === 0) return undefined;
  const listed = over72.length > 0 ? over72 : ownerGates.slice(0, OLDEST_LISTED);
  return { ...(medianHours !== undefined && { medianHours }), over72, listed };
}

/** The origin without a trailing slash, or undefined unless it is https and not loopback, so a digest never holds a link only the box can open. */
export function safeConsoleOrigin(origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  const host = url.hostname;
  const loopback = host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "0.0.0.0" || /^127\./.test(host);
  return url.protocol === "https:" && !loopback ? url.origin : undefined;
}

const refOf = (g: WaitingGate): string => (g.pr === null ? g.gateId : `${g.repo}#${g.pr}`);

function gateText(g: WaitingGate, origin: string | undefined): string {
  const link = origin === undefined ? "" : ` ${origin}/#/inbox/${encodeURIComponent(`gate:${g.gateId}`)}`;
  return `${refOf(g)} ${g.ageHours}h${link}`;
}

/** The top line; `shown` cuts the list when the digest would pass its word limit. */
export function alarmLine(alarm: GateAlarm, origin: string | undefined, shown: number = alarm.listed.length): string {
  const median = alarm.medianHours !== undefined && alarm.medianHours > MEDIAN_ALARM_HOURS ? [`${APPROVE_MERGE} median ${alarm.medianHours}h (>${MEDIAN_ALARM_HOURS}h)`] : [];
  const over = alarm.over72.length > 0 ? [`${alarm.over72.length} over ${GATE_ALARM_HOURS}h`] : [];
  const head = [...median, ...over].join("; ");
  const gates = alarm.listed.slice(0, shown).map((g) => gateText(g, origin)).join(", ");
  const more = alarm.listed.length - shown;
  return `Owner gates stale: ${head}: ${gates}${more > 0 ? `, and ${more} more` : ""}`;
}
