import type { ScriptBeat } from "../script-schema.js";
import { firstWord, itemReveals, marked, type Mark } from "./label-parse.js";
import { isDerived, type BeatScope, type Derivation, type Derived, type Lead, type Reveal } from "./types.js";

// A chapter heading fits beside at most 3 rows; a 4th makes the heading give way (the sample builder's HEADED_ROWS_MAX).
const HEADED_ROWS_MAX = 3;
const TITLE_MAX = 48;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The specs whose later beats in a chapter extend the lead's stage, and the slot field holding its rows. */
const STAGE_FIELDS: Readonly<Record<string, string>> = { list: "rows", "verdict-card": "reasons", "issue-pin": "issues" };
const HEADING_FIELDS: Readonly<Record<string, readonly string[]>> = { list: ["title"], "verdict-card": ["verdict", "call"], "issue-pin": ["title"] };

/** The chapter label as a title slot, left out when it is longer than a title holds. */
export const chapterTitle = (scope: BeatScope): { title?: string } => (scope.chapter.label.length <= TITLE_MAX ? { title: scope.chapter.label } : {});

/** List rows from the labels (the assertion when there are none), under the chapter label; `mark` overrides every row's. */
export function deriveList(beat: ScriptBeat, scope: BeatScope, mark?: Mark): Derived {
  const labels = beat.visual.labels.length > 0 ? beat.visual.labels : [beat.visual.assertion];
  const rows = labels.map((label, i) => {
    const row = marked(label);
    return { id: `rows-${i + 1}`, text: row.text, mark: mark ?? row.mark, ...(row.lane === undefined ? {} : { lane: row.lane }) };
  });
  const hints = rows.length > HEADED_ROWS_MAX ? { headingYields: true as const } : {};
  return { slots: { ...chapterTitle(scope), rows }, reveals: itemReveals(beat, "rows", rows.length), hints };
}

const textItems = (field: string, texts: readonly string[]) => texts.map((text, i) => ({ id: `${field}-${i + 1}`, text }));

function verdictSlots(beat: ScriptBeat, verdict: string, call: string, reasons: readonly string[]): Derived {
  return { slots: { verdict, call, reasons: textItems("reasons", reasons) }, reveals: itemReveals(beat, "reasons", reasons.length), hints: { qaLeadLine: true } };
}

/** The verdict is the first label, its call the head before `: ` (or the first chip), the other labels its reasons. */
export function deriveVerdict(beat: ScriptBeat): Derivation {
  const [lead, ...reasons] = beat.visual.labels;
  const call = lead?.includes(": ") ? lead.slice(0, lead.indexOf(": ")) : beat.visual.chips[0]?.text;
  if (call === undefined) return { reason: "verdict-card has no call: no `<call>: …` first label and no chip" };
  if (reasons.length === 0) return { reason: "verdict-card has no reasons: no label after the verdict" };
  return verdictSlots(beat, lead ?? beat.visual.assertion, call, reasons);
}

/** Each map pin as an issue on its own cue word, under the pinned node labels; with no pins, a list of problems. */
export function deriveIssues(beat: ScriptBeat, scope: BeatScope): Derivation {
  const pins = beat.visual.map_state?.pins ?? [];
  if (pins.length === 0) return { reason: "issue-pin has no map_state pins", fallback: { spec: "list", derived: deriveList(beat, scope, "cross") } };
  const labels = new Map((scope.map?.nodes ?? []).map((node) => [node.id, node.label]));
  const name = (anchor: string): string => labels.get(anchor) ?? anchor;
  const issues = pins.map((pin, i) => ({ id: `issues-${i + 1}`, title: `${name(pin.anchor)}: ${pin.text}`, severity: "medium", ...(KEBAB.test(pin.anchor) ? { pin: pin.anchor } : {}) }));
  const title = [...new Set(pins.map((pin) => pin.anchor))].map(name).join(" → ");
  return { slots: { title, issues }, reveals: pins.map((pin, i) => ({ target: `issues-${i + 1}`, atCue: pin.atCue })) };
}

/** A list of labels as `{id, text}` items in `field`; no labels derives nothing. */
export const deriveItems =
  (field: string) =>
  (beat: ScriptBeat): Derivation => {
    const { labels } = beat.visual;
    if (labels.length === 0) return { reason: `no labels to fill ${field}` };
    return { slots: { [field]: textItems(field, labels) }, reveals: itemReveals(beat, field, labels.length) };
  };

/** The lead's last rows that still fit beside `own` rows, renamed `held-<n>` (n their place on the lead's stage). */
function heldRows(lead: Lead, own: number, beat: ScriptBeat): { items: Record<string, unknown>[]; reveals: Reveal[] } {
  const room = Math.max(0, HEADED_ROWS_MAX - own);
  const start = Math.max(0, lead.items.length - room);
  const items = lead.items.slice(start).map((item, i) => ({ ...item, id: `held-${start + i + 1}` }));
  return { items, reveals: items.map((item) => ({ target: item.id, atCue: firstWord(beat) })) };
}

/**
 * A later beat on its chapter lead's stage (the sample builder's S9): the lead's heading holds, the lead's last rows stay on from
 * the first word, then the beat's own rows. A verdict-card continuation reads every label as a reason.
 */
export function deriveContinuation(beat: ScriptBeat, scope: BeatScope, lead: Lead, own: Derivation): Derivation {
  const { labels } = beat.visual;
  const reasons = { slots: { reasons: textItems("reasons", labels) }, reveals: itemReveals(beat, "reasons", labels.length), hints: { qaLeadLine: true as const } };
  const found = lead.spec === "verdict-card" ? reasons : own;
  if (!isDerived(found)) return found;
  const mine = (found.slots[lead.field] as Record<string, unknown>[] | undefined) ?? [];
  const held = heldRows(lead, mine.length, beat);
  const hints = { ...(found.hints?.qaLeadLine ? { qaLeadLine: true as const } : {}), continues: lead.id };
  return { slots: { ...found.slots, ...lead.heading, [lead.field]: [...held.items, ...mine] }, reveals: [...held.reveals, ...found.reveals], hints };
}

/** The stage a filled beat opens or extends, for the chapter's next beats; undefined when it opens none. */
export function stageOf(id: string, spec: string, slots: Record<string, unknown>, lead: Lead | undefined): Lead | undefined {
  const field = STAGE_FIELDS[spec];
  if (field === undefined) return undefined;
  const heading = Object.fromEntries((HEADING_FIELDS[spec] ?? []).filter((key) => slots[key] !== undefined).map((key) => [key, slots[key]]));
  const items = (slots[field] as Record<string, unknown>[] | undefined) ?? [];
  return { id: lead?.spec === spec ? lead.id : id, spec, heading, field, items };
}
