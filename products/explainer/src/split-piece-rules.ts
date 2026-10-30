import { HEADING_MAX_WORDS, LABEL_MAX_WORDS } from "./lint-direction.js";
import { FRAME_MAX_WORDS } from "./lint-frame-words.js";
import { ASSERTION_MAX_WORDS } from "./lint-headline.js";
import { ECHO_RUN_WORDS } from "./lint-screen.js";
import { PACING_DEFAULTS } from "./qa/timing-gates.js";
import { SETTLED_SPEECH_MAX_S } from "./settled-speech.js";

/** One L0 rule that reads a split piece's claim, chip or labels, with the clause the split hint gives for it. */
interface SplitPieceRule {
  id: string;
  /** Null when the rule is stated by `splitKeeps`, which the cue-less move shares (Q-E22 for a reflection piece). */
  clause: string | null;
}

/**
 * The rules a split piece's claim, chip and labels must pass. The model writes them after the code split, so each
 * rule it can fail there needs a clause in the hint; a lint rule that reads a chip or claim and is missing here is
 * found by the test that walks the L0 rows.
 */
export const SPLIT_PIECE_RULES: readonly SplitPieceRule[] = [
  { id: "Q-D14", clause: "no number on a chip or label that the piece does not speak" },
  { id: "Q-D16", clause: `no claim, chip or label repeating ${ECHO_RUN_WORDS} or more spoken words in a row` },
  { id: "Q-E22", clause: null },
  { id: "Q-E1", clause: "a verified or computed chip names a fact_id" },
  { id: "Q-E20", clause: "no PR, task or count on the screen that the cited facts do not back" },
  { id: "Q-D7", clause: `a claim with a subject and a verb in at most ${ASSERTION_MAX_WORDS} words` },
  { id: "Q-V13", clause: "a claim that wraps to at most two lines" },
  { id: "Q-D20", clause: `a heading of at most ${HEADING_MAX_WORDS} words and a label of at most ${LABEL_MAX_WORDS}` },
  { id: "Q-D21", clause: "a piece that draws no headline keeps a source chip, whose line rises at the cut" },
  { id: "Q-D15", clause: `at most ${FRAME_MAX_WORDS} words on screen at once` },
  { id: "Q-D22", clause: `a piece that is not held stands still at most ${PACING_DEFAULTS.staticMaxS} s once its claim and chip are read, or ${SETTLED_SPEECH_MAX_S} s while the voice speaks` },
];

/** The named rules' clauses, each led by its id, as the caps a move that adds text must stay within. */
export const capClauses = (ids: readonly string[]): string =>
  SPLIT_PIECE_RULES.flatMap((rule) => (ids.includes(rule.id) && rule.clause !== null ? [`${rule.id} (${rule.clause})`] : [])).join(" and ");

/** The table's clauses, joined for the split hint; the rules `splitKeeps` states are left to it. */
export const splitPieceClauses = (): string =>
  SPLIT_PIECE_RULES.flatMap((rule) => (rule.clause === null ? [] : [rule.clause])).join("; ");
