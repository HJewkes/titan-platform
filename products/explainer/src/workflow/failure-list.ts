import type { L0Result } from "../eval-l0.js";
import { repairHint } from "../l0-repair-hints.js";
import type { GatheredFact } from "../lint-claims.js";
import type { CoverageManifest } from "../lint-coverage.js";
import { spellScript } from "../rewrite-pass.js";
import type { RuleRegistry } from "../rules.js";
import { FILL_RULE, fillHint, TEMPLATE_FILL_ID } from "../script-fill.js";
import type { ScriptV1 } from "../script-schema.js";
import type { SpineV1 } from "../spine-schema.js";
import { UNKNOWN_WORDS_ID, UNKNOWN_WORDS_RULE, unknownWordsHint, type Tokens } from "../unknown-words.js";

/** What a repair round's failure list reads to name what each row found. */
export interface FailureContext {
  /** The gathered facts the Q-E20 rows read, so its hint names the nearest one. */
  facts?: readonly GatheredFact[];
  /** A daily gather's coverage manifest, so the Q-E21 hint names each lane and PR left out. */
  coverage?: CoverageManifest;
  spine: SpineV1;
  /** The voice's g2p, so the rounds also answer the words it has no phonemes for. */
  g2p: Tokens;
}

interface OwnRow {
  rule: string;
  hint: (row: L0Result) => string;
}

/** The rows the repair rounds answer that no L0 rule owns: each one's rule and Found line. */
const ownRows = (script: ScriptV1, lint: Pick<FailureContext, "g2p">): ReadonlyMap<string, OwnRow> =>
  new Map([
    [UNKNOWN_WORDS_ID, { rule: UNKNOWN_WORDS_RULE, hint: () => unknownWordsHint(lint.g2p, spellScript(script)) }],
    [TEMPLATE_FILL_ID, { rule: FILL_RULE, hint: (row: L0Result) => fillHint(script, row.detail_beats) }],
  ]);

/** Each failing row as a repair round lists it: its rule, where it failed, and what its hint found. */
export function failureList(rows: readonly L0Result[], rules: RuleRegistry, script: ScriptV1, lint: FailureContext): string {
  const ruleFor = (id: string) => rules.rules.find((rule) => rule.id === id || (rule.l0?.status === "implemented" && rule.l0.checks.includes(id)));
  const own = ownRows(script, lint);
  const rule = (row: L0Result) => own.get(row.check_id)?.rule ?? ruleFor(row.check_id)?.rule ?? "see the rules above";
  const where = (row: L0Result) => `beats: ${row.detail_beats.join(", ") || "the whole script"}; measured ${row.value}, needs ${row.threshold}`;
  const found = (row: L0Result) => {
    const hint = own.get(row.check_id)?.hint(row) ?? repairHint(row, script, lint.facts, lint.spine, lint.coverage);
    return hint ? `\n  Found: ${hint}` : "";
  };
  return rows.map((row) => `- ${row.check_id}: ${rule(row)} (${where(row)})${found(row)}`).join("\n");
}
