import { speaks, type SeatRoute } from "./lint-seat.js";
import { labelKey, type PaceBeat } from "./pace-items.js";
import type { SpineLedgerRow, SpineV1 } from "./spine-schema.js";

type SpineKind = SpineLedgerRow["kind"];

/** One list beat with the kind the spine ledger declares for each listed item. */
export interface KindRoute {
  beat: string;
  items: { label: string; kind: SpineKind }[];
}

const declared = (items: { label: string; kind: SpineKind | undefined }[]): items is KindRoute["items"] => items.every((i) => i.kind !== undefined);

/**
 * List beats whose every item the ledger declares a kind for. A beat with an unledgered item is left to the blind
 * odd one out: Q-E17 already fails it, and a half-declared list would ask the judge about kinds nobody stated.
 */
export function kindRoutes(lists: readonly { beat: string; items: readonly string[] }[], spine: SpineV1): KindRoute[] {
  const ledger = new Map(spine.ledger.map((row) => [labelKey(row.item), row.kind]));
  return lists.flatMap((list) => {
    const items = list.items.map((label) => ({ label, kind: ledger.get(labelKey(label)) }));
    return declared(items) ? [{ beat: list.beat, items }] : [];
  });
}

interface SpineInvariant {
  text: string;
  id: string | null;
  step: number;
}

const INVARIANT_ID = /^([a-z]+\d+)\b/i;
const idOf = (text: string): string | null => INVARIANT_ID.exec(text.trim())?.[1]?.toUpperCase() ?? null;
const phraseOf = (text: string): string => text.trim().replace(INVARIANT_ID, "").trim();

const spineInvariants = (spine: SpineV1): SpineInvariant[] =>
  spine.journey.flatMap((row) => (row.invariant ? [{ text: row.invariant, id: idOf(row.invariant), step: row.n }] : []));

/** A beat states a spine invariant by an `inv:` label carrying its id or its text, or by speaking its phrase. */
function states(beat: PaceBeat, inv: SpineInvariant): boolean {
  const labels = beat.items.filter((i) => i.kind === "inv").map((i) => i.label);
  const labelled = labels.some((l) => labelKey(l) === labelKey(inv.text) || (inv.id !== null && idOf(l) === inv.id));
  const phrase = phraseOf(inv.text);
  return labelled || (phrase !== "" && speaks(beat.spoken, phrase));
}

// §4's mechanism column names the invariants a part keeps by id; an invariant with no id can only be matched by
// the journey step the part carries.
const keeps = (row: SpineV1["architecture"][number], inv: SpineInvariant): boolean =>
  row.mechanism !== null && (inv.id !== null ? new RegExp(`\\b${inv.id}\\b`, "i").test(row.mechanism) : row.carries.includes(String(inv.step)));

/** Where the spine seats an invariant beat: the §3 invariant it states and the §4 part that keeps it, each null when none matches. */
export interface SpineSeat {
  beat: string;
  invariant: string | null;
  part: string | null;
}

function spineSeat(beat: string, track: ReadonlyMap<string, PaceBeat>, spine: SpineV1): SpineSeat {
  const found = track.get(beat);
  const invariant = found && spineInvariants(spine).find((inv) => states(found, inv));
  const row = invariant && spine.architecture.find((r) => keeps(r, invariant));
  return { beat, invariant: invariant?.text ?? null, part: row?.part ?? null };
}

/** The spine seat of each invariant seat route, keyed by beat. Finding routes have no §3 invariant to pair. */
export function spineSeats(beats: readonly PaceBeat[], seats: readonly SeatRoute[], spine: SpineV1): Map<string, SpineSeat> {
  const track = new Map(beats.map((b) => [b.id, b]));
  return new Map(seats.filter((r) => r.reason === "invariant").map((r) => [r.beat, spineSeat(r.beat, track, spine)]));
}
