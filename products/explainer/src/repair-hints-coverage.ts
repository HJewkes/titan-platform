import type { GatheredFact } from "./lint-claims.js";
import {
  COVERAGE_CHECK_ID, coverageFindings, LANES_CHAPTER, PRIORITY_PREFIX, REFLECTION_CHAPTER, REFLECTION_CHECK_ID, SLOWDOWN_PREFIX,
  uncitedReflections, type CoverageFinding, type CoverageManifest,
} from "./lint-coverage.js";
import { listed, type Hint } from "./repair-hint.js";
import type { ScriptV1 } from "./script-schema.js";

const MAX_NAMED = 12;

const findingLine = (finding: CoverageFinding): string =>
  finding.kind === "lane"
    ? `lane ${finding.lane}: ${finding.uncited} of its ${finding.merged} merged PRs are uncited, so cite ${finding.rollup} in a ${LANES_CHAPTER} beat and say ${finding.merged} in it`
    : `lane ${finding.lane} names ${finding.pr}: cite it in the fact_ids of the beat that names it`;

function coverageHint(script: ScriptV1, coverage?: CoverageManifest): string {
  if (!coverage) return `every merged PR must be cited, or counted by a ${LANES_CHAPTER} beat that cites its lane's rollup fact and says the lane's total`;
  const lines = coverageFindings(script, coverage).map(findingLine);
  const more = lines.length > MAX_NAMED ? `; and ${lines.length - MAX_NAMED} more like these` : "";
  return `${lines.slice(0, MAX_NAMED).join("; ")}${more}`;
}

function reflectionHint(script: ScriptV1, facts?: readonly GatheredFact[]): string {
  const slowdowns = (facts ?? []).map((fact) => fact.id).filter((id) => id.startsWith(SLOWDOWN_PREFIX));
  const beats = uncitedReflections(script).map((beat) => beat.id);
  return `${REFLECTION_CHAPTER} beats citing no slowdown or priority fact: ${listed(beats)}. Cite in each proposal the ${SLOWDOWN_PREFIX} fact it answers (${listed(slowdowns)}), or a ${PRIORITY_PREFIX} fact when the beat names a priority`;
}

export const COVERAGE_HINTS: Readonly<Record<string, Hint>> = {
  [COVERAGE_CHECK_ID]: (script, _row, _facts, _spine, coverage) => coverageHint(script, coverage),
  [REFLECTION_CHECK_ID]: (script, _row, facts) => reflectionHint(script, facts),
};
