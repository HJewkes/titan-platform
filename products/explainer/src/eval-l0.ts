import { deriveEvalView, toMapBeats, type EvalBeat } from "./eval-view.js";
import { lintMapBeats, type MapLint, type MapLintRule } from "./map-lints.js";
import { evidenceCheck } from "./lint-evidence.js";
import { whyCheck } from "./lint-why.js";
import type { MapLayout } from "./map-state.js";
import type { ScriptV1 } from "./script-schema.js";
import type { StructureRow } from "./eval-store.js";
import { flowCheck } from "./lint-flow.js";
import { voiceCheck } from "./lint-voice.js";
import { heteronymCheck } from "./lint-heteronyms.js";
import { paceCheck } from "./lint-pace.js";
import { visualKindCheck } from "./lint-visual-kind.js";
import type { ScriptTiming } from "./timing.js";

/** One check's verdict before it is keyed to a config, script and registry. */
export type L0Result = Omit<StructureRow, "config_id" | "script_sha" | "rules_sha">;

export interface L0Input {
  script: ScriptV1;
  view: EvalBeat[];
  layout?: MapLayout;
  /** Heard durations from a words.json; without them the pace lints read planned lengths. */
  timing?: ScriptTiming;
}

/** A deterministic check over a script. It reports every rule it owns, passing or not, so a pass is a row too. */
export type L0Check = (input: L0Input) => L0Result[];

const MAP_LINT_SEVERITY: Record<MapLintRule, MapLint["severity"]> = {
  "level-step": "error",
  "new-boxes": "error",
  "full-weight": "error",
  "unknown-id": "error",
  "edge-source": "error",
  "hand-framing": "error",
  "card-per-cue": "error",
  "flow-hops": "error",
  "flow-replay": "error",
  "return-to-map": "warning",
};

/** The map track's lints, one row per rule; it needs the layout, so a run without one skips it. */
export const mapLintCheck: L0Check = ({ script, layout }) => {
  if (!layout) return [];
  const lints = lintMapBeats(toMapBeats(script), layout);
  return Object.entries(MAP_LINT_SEVERITY).map(([rule, severity]) => {
    const beats = [...new Set(lints.filter((lint) => lint.rule === rule).map((lint) => lint.beatId))];
    return { check_id: `map:${rule}`, mode: "tagged", severity, value: beats.length, threshold: 0, pass: beats.length === 0, detail_beats: beats };
  });
};

export const L0_CHECKS: readonly L0Check[] = [mapLintCheck, whyCheck, evidenceCheck, voiceCheck, flowCheck, paceCheck, heteronymCheck, visualKindCheck];

export function runL0(script: ScriptV1, layout?: MapLayout, checks: readonly L0Check[] = L0_CHECKS, timing?: ScriptTiming): L0Result[] {
  const input: L0Input = { script, view: deriveEvalView(script, layout), ...(layout ? { layout } : {}), ...(timing ? { timing } : {}) };
  return checks.flatMap((check) => check(input));
}

/** L0 filters on errors only; a warning is recorded but never fails a script. */
export const l0HardPass = (results: readonly L0Result[]): boolean =>
  results.every((result) => result.severity === "warning" || result.pass);

/** The failing check ids, a warning marked so a reader does not take it for a gate. */
export const failedChecks = (results: readonly L0Result[]): string[] =>
  results.filter((r) => !r.pass).map((r) => `${r.check_id}${r.severity === "warning" ? " (warning)" : ""}`);
