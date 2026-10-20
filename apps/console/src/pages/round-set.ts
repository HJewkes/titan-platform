import type { RoundSummary } from "../../server/rounds.js";

/** `rounds import` names a round dir `<unit>-r<round>`, so an invalid round's id still names its set. */
const IMPORTED_ID = /^(.+)-r(\d+)$/;

/** The set a round belongs to: its manifest's unit, else the id before `-rN`, else none. */
export function setKeyOf(round: RoundSummary): string | null {
  if (round.valid) return round.unit;
  return IMPORTED_ID.exec(round.id)?.[1] ?? null;
}

function roundNumberOf(round: RoundSummary): number {
  if (round.valid) return round.round;
  const digits = IMPORTED_ID.exec(round.id)?.[2];
  return digits === undefined ? Number.POSITIVE_INFINITY : Number(digits);
}

/** The manifest has no created time; the round number orders a set, and mtime then id break a tie. */
function earliestFirst(a: RoundSummary, b: RoundSummary): number {
  return roundNumberOf(a) - roundNumberOf(b) || (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "") || a.id.localeCompare(b.id);
}

/** Every round in `set`, earliest first. */
export function roundsInSet(rounds: readonly RoundSummary[], set: string): RoundSummary[] {
  return rounds.filter((round) => setKeyOf(round) === set).sort(earliestFirst);
}

export interface SetPosition {
  set: string;
  /** 1-based place of the round in its set. */
  index: number;
  size: number;
  prev: RoundSummary | null;
  next: RoundSummary | null;
}

/** Where round `id` sits in its set, or null when the list does not hold it or it has no set. */
export function setPositionOf(rounds: readonly RoundSummary[], id: string): SetPosition | null {
  const current = rounds.find((round) => round.id === id);
  const set = current === undefined ? null : setKeyOf(current);
  if (set === null) return null;
  const members = roundsInSet(rounds, set);
  const at = members.findIndex((round) => round.id === id);
  return { set, index: at + 1, size: members.length, prev: members[at - 1] ?? null, next: members[at + 1] ?? null };
}

/** The `#/rounds` query that shows one set. */
export function setQuery(set: string): string {
  return new URLSearchParams({ set }).toString();
}

export function setFromQuery(query: string | undefined): string | null {
  return new URLSearchParams(query ?? "").get("set");
}
