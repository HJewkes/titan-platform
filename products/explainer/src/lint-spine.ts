import type { L0Check, L0Result } from "./eval-l0.js";
import { ruleRow } from "./lint-text.js";
import { labelKey } from "./pace-items.js";
import type { SpineV1 } from "./spine-schema.js";

const JOURNEY_SECTION = 3;
const ARCHITECTURE_SECTION = 4;

/** The check ids `spineCheck` emits; a run without a spine skips them, so they are not ghosts there. */
export const SPINE_CHECK_IDS: ReadonlySet<string> = new Set(["Q-E15", "Q-E18"]);

const row = (check_id: string, beats: readonly string[]): L0Result =>
  ruleRow(check_id, { value: beats.length, threshold: 0, pass: beats.length === 0, beats, mode: "tagged", severity: "error" });

// A planner leaves a cell as a dash when it has nothing to say; a dash is not a reason.
const isBlank = (text: string): boolean => /^[-—–\s]*$/.test(text);

/** The template section a chapter's "spine rows" cell cites ("§3.2" is section 3), or undefined for a cell that cites none. */
const sectionOf = (cited: string): number | undefined => {
  const match = /^§?\s*(\d+)/.exec(cited.trim());
  return match ? Number(match[1]) : undefined;
};

const cites = (rows: readonly string[], section: number): boolean => rows.some((r) => sectionOf(r) === section);

/**
 * Chapters that show the architecture before any chapter follows the journey. Order is the position in the §8 table,
 * never the chapter id: as text "ch10" sorts before "ch2".
 */
function architectureFirst(spine: SpineV1): string[] {
  const firstJourney = spine.chapters.findIndex((c) => cites(c.rows, JOURNEY_SECTION));
  const limit = firstJourney < 0 ? spine.chapters.length : firstJourney;
  return spine.chapters.filter((c, at) => at < limit && cites(c.rows, ARCHITECTURE_SECTION)).map((c) => c.chapter);
}

const unexplainedSteps = (spine: SpineV1): string[] => spine.journey.filter((step) => isBlank(step.why)).map((step) => `§3.${step.n}`);

/** Q-E15 (FB1): the journey comes before the architecture, and each journey step says why it is needed. */
export function journeyOrderRow(spine: SpineV1): L0Result {
  return row("Q-E15", [...architectureFirst(spine), ...unexplainedSteps(spine)]);
}

const idToken = (invariant: string): string | undefined => /^[A-Za-z]{1,3}\d+\b/.exec(invariant.trim())?.[0];

/** True when `text` names the invariant, by its id (I1) or by its words. */
function mentions(text: string, invariant: string): boolean {
  const id = idToken(invariant);
  if (id && new RegExp(`\\b${id}\\b`, "i").test(text)) return true;
  return labelKey(text).includes(labelKey(invariant));
}

// An architecture row keeps an invariant only by stating a mechanism for it; a part that merely carries the step does not.
const keptBy = (spine: SpineV1, invariant: string): boolean => spine.architecture.some((part) => part.mechanism !== null && mentions(part.mechanism, invariant));

const seatedJourneyInvariants = (spine: SpineV1): string[] =>
  spine.journey.flatMap((step) => (step.invariant !== null && (step.breaksToday !== null || keptBy(spine, step.invariant)) ? [step.invariant] : []));

const unseatedJourney = (spine: SpineV1): string[] =>
  spine.journey.filter((step) => step.invariant !== null && step.breaksToday === null && !keptBy(spine, step.invariant)).map((step) => `§3.${step.n}`);

// A video-level invariant is seated by a seated journey invariant that says the same thing, or by a mechanism that states it.
function unseatedVideo(spine: SpineV1, invariants: readonly string[]): string[] {
  const seated = seatedJourneyInvariants(spine);
  return invariants.filter((inv) => !keptBy(spine, inv) && !seated.some((s) => mentions(s, inv) || mentions(inv, s)));
}

/** Q-E18 (FB6): each invariant names the architecture row that keeps it, or the fact that shows how it breaks today. */
export function invariantSeatRow(spine: SpineV1, videoInvariants: readonly string[] = []): L0Result {
  return row("Q-E18", [...unseatedJourney(spine), ...unseatedVideo(spine, videoInvariants)]);
}

/** The spine order and seat lints. With no spine there is nothing to read, so no rows (unlike the ledger rows, no profile requires these). */
export const spineCheck: L0Check = ({ script, spine }) => (spine ? [journeyOrderRow(spine), invariantSeatRow(spine, script.video.invariants ?? [])] : []);
