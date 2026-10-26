import { useBeatTime } from "@titan-design/react-ui/motion";
import type { ReactNode } from "react";
import type { TimelineBeat } from "../../timeline.js";
import { StageContext } from "./stageFit.js";
import { fadeUp } from "./video.js";

type Chip = NonNullable<TimelineBeat["chips"]>[number];
type Chapter = NonNullable<TimelineBeat["chapter"]>;

/**
 * One 40 px source line holds this many characters, "+N" included: the 1800 px band less the widest kind tag
 * ("our-framing", about 278 px) leaves 1522 px, and mono at 40 px is about 24 px a character.
 */
export const SOURCE_BUDGET = 63;

interface SourceRef {
  kind: string;
  text: string;
  more: number;
}

/** The words the source line shows: the shortened first source, then "+N" for the other sources. */
export const chipText = (line: SourceRef) => (line.more ? `${line.text} +${line.more}` : line.text);

/** Drops `repo@sha:` and directory prefixes, so `tp@a1b8cdeb:products/x/wake.ts:35` reads `wake.ts:35`. */
const shortRef = (ref: string) => ref.replace(/^[\w-]+@[0-9a-f]+:/, "").replace(/(?:[\w.~-]+\/)+/g, "");

/** The beat's first source, shortened, and how many more sources its chips cite; over the budget throws, never clips. */
export function sourceLine(chips: readonly Chip[]): SourceRef | undefined {
  const refs = chips.flatMap((c) => c.text.split("; ").map((ref) => ({ kind: c.kind, ref })));
  const first = refs[0];
  if (!first) return undefined;
  const line = { kind: first.kind, text: shortRef(first.ref), more: refs.length - 1 };
  const shown = chipText(line);
  if (shown.length > SOURCE_BUDGET) throw new Error(`source "${shown}" is over the ${SOURCE_BUDGET}-character chip budget`);
  return line;
}

function SourceLine({ chips, t }: { chips: readonly Chip[]; t: number }) {
  const line = sourceLine(chips);
  if (!line) return null;
  return (
    <p className="xp-chips" style={fadeUp(t, 0.15, 8)}>
      <span className="xp-chip-kind" data-kind={line.kind}>{line.kind}</span>
      {line.text}
      {line.more > 0 && <span className="xp-chip-more">+{line.more}</span>}
    </p>
  );
}

function ChapterLine({ chapter }: { chapter: Chapter }) {
  return (
    <p className="xp-chapter">
      <span className="xp-chapter-count">{chapter.n}/{chapter.of}</span>
      {chapter.label}
    </p>
  );
}

interface ChromeProps {
  headline?: string;
  chips: readonly Chip[];
  chapter?: Chapter;
}

/** Headline band, then the stage slot, then the source and chapter band, laid over the beat in the beat's own time. */
export function Chrome({ headline, chips, chapter }: ChromeProps) {
  const { t, phase } = useBeatTime();
  return (
    <div className="xp-chrome beat-scale" style={{ visibility: phase === "during" ? "visible" : "hidden" }}>
      <header className="xp-band-top">
        {headline !== undefined && <h1 className="xp-headline" style={fadeUp(t, 0.05, 16)}>{headline}</h1>}
      </header>
      <div className="xp-stage-slot" />
      <footer className="xp-band-bottom">
        <SourceLine chips={chips} t={t} />
        {chapter && <ChapterLine chapter={chapter} />}
      </footer>
    </div>
  );
}

/** The box between the chrome bands, sized from the same band tokens; a beat frame inside it must fit or throw. */
export function Stage({ beat, children }: { beat: string; children?: ReactNode }) {
  return (
    <StageContext value={beat}>
      <div className="xp-stage beat-scale" data-stage={beat}>{children}</div>
    </StageContext>
  );
}
