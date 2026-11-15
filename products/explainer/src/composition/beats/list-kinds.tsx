import { Pill, type PillTone } from "@titan-design/react-ui";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { ListFrame, type ListItem, type ListMark } from "./ListBeat.js";
import type { Reveal } from "./stage/reveal.js";

type Slots<K extends keyof typeof BEAT_SLOTS> = z.infer<(typeof BEAT_SLOTS)[K]>;
type ListRow = Slots<"list">["rows"][number];

// A fill mark names the label's first word; a cross is the spike's problem row and a dot its neutral one.
const MARKS: Record<ListRow["mark"], ListMark> = { tick: "tick", cross: "problem", risk: "risk", open: "open", dot: "neutral" };
// The sample builder's HEADED_ROWS_MAX: a heading fits beside at most 3 rows, so a longer list's heading gives way.
const HEADED_ROWS_MAX = 3;

/** A row with no cue of its own lands with the beat. */
const landing = (reveal: Reveal, id: string): number => reveal(id) ?? 0;

const firstLanding = (items: readonly ListItem[]): number | undefined => (items.length === 0 ? undefined : Math.min(...items.map((item) => item.atS)));

const yieldsAt = (yields: boolean, items: readonly ListItem[]) => {
  const atS = yields ? firstLanding(items) : undefined;
  return atS === undefined ? {} : { headingYieldsAtS: atS };
};

/** list: the chapter title over rows with their marks, a row's lane as its chip; past 3 rows the title yields. */
export function ListKindBeat({ slots, reveal, hints }: BeatViewProps<Slots<"list">>) {
  const items = slots.rows.map((row) => ({ id: row.id, text: row.text, mark: MARKS[row.mark], atS: landing(reveal, row.id), ...(row.lane ? { ref: row.lane } : {}) }));
  return <ListFrame heading={slots.title ?? ""} items={items} {...yieldsAt(hints.headingYields === true, items)} />;
}

const CALL_TONES: Record<string, PillTone> = { ship: "success", fix: "warning", avoid: "error" };

const callTone = (call: string): PillTone => CALL_TONES[call.trim().split(/\s+/)[0]?.toLowerCase() ?? ""] ?? "neutral";

/** The fill writes the verdict as "<call>: <reason>"; the chip carries the call, so the heading keeps the reason. */
const withoutCallPrefix = (verdict: string, call: string): string => {
  const prefix = `${call}: `;
  return verdict.toLowerCase().startsWith(prefix.toLowerCase()) ? verdict.slice(prefix.length) : verdict;
};

/** verdict-card: the verdict is the heading from the start with its call as a toned chip, its reasons neutral rows on their cues. */
export function VerdictCardBeat({ slots, reveal, hints }: BeatViewProps<Slots<"verdict-card">>) {
  const items = slots.reasons.map((reason) => ({ id: reason.id, text: reason.text, mark: "neutral" as const, atS: landing(reveal, reason.id) }));
  const { call } = slots;
  const chip = call ? <span data-verdict-call={callTone(call)}><Pill tone={callTone(call)} size="lg">{call}</Pill></span> : undefined;
  return <ListFrame heading={call ? withoutCallPrefix(slots.verdict, call) : slots.verdict} items={items} leadLine={hints.qaLeadLine === true} headingAdornment={chip} />;
}

/** fact-flash: each fact a dot row on its word, under the chapter label. */
export function FactFlashBeat({ slots, reveal, chapter }: BeatViewProps<Slots<"fact-flash">>) {
  const items = slots.facts.map((fact) => ({ id: fact.id, text: fact.text, mark: "neutral" as const, atS: landing(reveal, fact.id) }));
  return <ListFrame heading={chapter ?? ""} items={items} {...yieldsAt(items.length > HEADED_ROWS_MAX, items)} />;
}
