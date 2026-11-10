import { cueTargetKind } from "./pace-items.js";
import type { ScriptBeat } from "./script-schema.js";

/** The generic kinds a catalogue video once used for terminal and timeline content, before cmd, out and event existed. */
const GENERIC_KINDS: ReadonlySet<string> = new Set(["run", "detail", "note"]);

const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
// A shell prompt marks a command, a test or exit summary marks output, a leading date marks a timeline event.
const SHAPES: ReadonlyArray<{ replacement: string; pattern: RegExp }> = [
  { replacement: "cmd", pattern: /^\$\s/ },
  { replacement: "out", pattern: /^(?:exit (?:code )?\d+\b|\d+ (?:passed|failed)\b)/i },
  { replacement: "event", pattern: new RegExp(`^(?:\\d{4}-\\d{2}-\\d{2}\\b|${MONTH}\\.? \\d{1,2}\\b)`) },
];

export interface StandIn {
  target: string;
  replacement: string;
}

/** Cues that put terminal or timeline content under run, detail or note; a beat spec's cues are element ids, so it has none. */
export function cueStandIns(beat: Pick<ScriptBeat, "visual">): StandIn[] {
  if (beat.visual.beat !== undefined) return [];
  return beat.visual.cues.flatMap(({ target }) => {
    if (!GENERIC_KINDS.has(cueTargetKind(target))) return [];
    const label = target.slice(target.indexOf(":") + 1);
    const shape = SHAPES.find(({ pattern }) => pattern.test(label));
    return shape ? [{ target, replacement: shape.replacement }] : [];
  });
}
