import { MOTION, useBeatTime } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { litBox, useLit } from "./stage/emphasis.js";
import { enter } from "./stage/entrance.js";

/**
 * Port of the daily spike's TitleBeat.tsx (SOURCE_REV 6a09ca2) without its own Beat or eyebrow (the stage hides
 * eyebrows). The spike's stagger was uncapped; react-ui's caps the cascade, so the word delay is written out.
 */

const WORDS_START_S = 0.15;
const WORD_EACH_S = 0.08;

interface TitleFrameProps {
  title: string;
  subtitle?: string;
  /** Beat-local seconds the first word starts its rise. */
  atS: number;
}

function TitleFrame({ title, subtitle, atS }: TitleFrameProps) {
  const { t } = useBeatTime();
  const words = title.split(/\s+/).filter(Boolean);
  const wordStart = (i: number) => atS + WORDS_START_S + i * WORD_EACH_S;
  const lit = useLit()("claim", t);
  return (
    <>
      <h1 className="beat-title" data-reveal="claim" style={litBox(lit)}>
        {words.map((word, i) => (
          <span key={i} className="beat-word" style={enter(t, wordStart(i))}>{word}</span>
        ))}
      </h1>
      {subtitle && <p className="beat-subtitle" data-subtitle="" style={enter(t, wordStart(words.length) + MOTION.duration.normal)}>{subtitle}</p>}
    </>
  );
}

/**
 * claim-card, as its spec says (a TitleBeat; owner question Q1 at P3): the claim word by word, then its quote when it
 * has one, the claim lit when a later cue names it. The source chip is the chrome's, from the same chip the fill read the claim's source off.
 */
export function ClaimCardBeat({ slots, reveal }: BeatViewProps<z.infer<(typeof BEAT_SLOTS)["claim-card"]>>) {
  return <TitleFrame title={slots.claim} atS={reveal("claim") ?? 0} {...(slots.quote ? { subtitle: `“${slots.quote.text}”` } : {})} />;
}
