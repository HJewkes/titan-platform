import { StateChip, type ChipState } from "@titan-design/react-ui";
import { useBeatTime } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { progressAt } from "./stage/entrance.js";

type Check = z.infer<(typeof BEAT_SLOTS)["proof"]>["checks"][number];

/** The page's type floor (`--beat-floor`): a chip drawn smaller reads as small text to qa. */
const CHIP_FONT_PX = 40;

/** Fail and absent both read as a requirement not yet met; only a pass is met. */
const stateOf = (outcome: Check["base"] | Check["head"]): ChipState => (outcome === "pass" ? "met" : "unmet");

/**
 * The chip rests at its base state until `atS`, then moves to head as a pure function of beat time, so a frame
 * sampled alone matches the same frame reached by playing through. A check whose two ends agree never moves.
 */
function CheckRow({ check, t, atS }: { check: Check; t: number; atS: number }) {
  const base = stateOf(check.base);
  const head = stateOf(check.head);
  const progress = progressAt(t, atS);
  const moving = progress > 0;
  return (
    <li className="beat-check-item" data-reveal={check.id}>
      <span className="beat-proof-name">{check.name}</span>
      <StateChip text={check.name} state={moving ? head : base} from={base} progress={progress} fontPx={CHIP_FONT_PX} />
    </li>
  );
}

/** proof: the command line when there is one, then a row per check whose chip turns from base to head on its cue. */
export function ProofKindBeat({ slots, reveal }: BeatViewProps<z.infer<(typeof BEAT_SLOTS)["proof"]>>) {
  const { t } = useBeatTime();
  return (
    <div className="beat-proof">
      {slots.command && <code className="beat-proof-command">{slots.command}</code>}
      <ul className="beat-checklist">
        {slots.checks.map((check) => <CheckRow key={check.id} check={check} t={t} atS={reveal(check.id) ?? 0} />)}
      </ul>
    </div>
  );
}
