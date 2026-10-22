/**
 * A console-side bridge until titan-design TD-995 gives image variants a declared sequence: image variants keyed
 * `<base>-p<n>` (`_` as the decimal point, so `-p0_5` is 0.5) are guessed to be one motion's stills. Delete this
 * module and draw TD-995's field instead once it lands.
 */

/** One still of a guessed sequence: its variant key and the progress its key names. */
export interface ProgressStill {
  key: string;
  progress: number;
  /** The progress as its key writes it, with a decimal point: "0.5". */
  label: string;
}

export interface StillSequence {
  base: string;
  /** Two or more stills, in progress order. */
  steps: readonly ProgressStill[];
}

/** A frame to draw on its own, or a guessed sequence drawn as one viewer where its first still stood. */
export type FrameItem = { kind: "frame"; key: string } | { kind: "sequence"; sequence: StillSequence };

const PROGRESS_KEY = /^(.+)-p(\d+(?:_\d+)?)$/;

/** The base and progress a `-p<n>` key names, or undefined for any other key. */
function progressStill(key: string): { base: string; still: ProgressStill } | undefined {
  const match = PROGRESS_KEY.exec(key);
  if (match === null) return undefined;
  const [, base = "", written = ""] = match;
  const label = written.replace("_", ".");
  return { base, still: { key, progress: Number(label), label } };
}

/** The stills of each base among the image keys, kept only where a base has two or more. */
function sequencesOf(keys: readonly string[], isImage: (key: string) => boolean): Map<string, StillSequence> {
  const stills = new Map<string, ProgressStill[]>();
  for (const key of keys) {
    const parsed = isImage(key) ? progressStill(key) : undefined;
    if (parsed) stills.set(parsed.base, [...(stills.get(parsed.base) ?? []), parsed.still]);
  }
  const sequences = new Map<string, StillSequence>();
  for (const [base, steps] of stills) {
    if (steps.length >= 2) sequences.set(base, { base, steps: [...steps].sort((a, b) => a.progress - b.progress) });
  }
  return sequences;
}

/** `keys` in order, each guessed sequence folded into one item where its first still stood. */
export function groupProgressStills(keys: readonly string[], isImage: (key: string) => boolean): FrameItem[] {
  const sequences = sequencesOf(keys, isImage);
  const drawn = new Set<string>();
  return keys.flatMap((key): FrameItem[] => {
    const base = progressStill(key)?.base;
    const sequence = base === undefined ? undefined : sequences.get(base);
    if (sequence === undefined || !sequence.steps.some((step) => step.key === key)) return [{ kind: "frame", key }];
    if (drawn.has(sequence.base)) return [];
    drawn.add(sequence.base);
    return [{ kind: "sequence", sequence }];
  });
}
