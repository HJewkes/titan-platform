import { readFileSync } from "node:fs";
import { MOTION, springSettleS } from "@titan-design/react-ui/motion";
import { describe, expect, it } from "vitest";
import {
  CLAIM_WORDS_START_S,
  CLAIM_WORD_EACH_S,
  OUTRO_ACTION_S,
  STAT_COUNT_SETTLE_S,
  STAT_COUNT_SPRING,
  STAT_COUNT_START_S,
  STAT_COUNT_VISIBLE,
  revealMotionS,
} from "./drawn-motion.js";

const template = (name: string): string => readFileSync(new URL(`./composition/beats/${name}`, import.meta.url), "utf8");
const constant = (source: string, name: string): string | undefined => new RegExp(`const ${name} = ([^;]+);`).exec(source)?.[1];

describe("the drawn kinds' motion, as the templates draw it", () => {
  it("mirrors each template's own timing constants", () => {
    const title = template("TitleBeat.tsx");
    const stat = template("StatBeat.tsx");
    const outro = template("OutroBeat.tsx");

    const read = [constant(title, "WORDS_START_S"), constant(title, "WORD_EACH_S"), constant(stat, "COUNT_START_S"), constant(stat, "COUNT_SPRING"), constant(outro, "ACTION_S")];

    expect(read).toEqual([String(CLAIM_WORDS_START_S), String(CLAIM_WORD_EACH_S), String(STAT_COUNT_START_S), `{ stiffness: ${STAT_COUNT_SPRING.stiffness}, damping: ${STAT_COUNT_SPRING.damping} } as const`, String(OUTRO_ACTION_S)]);
  });

  it("a longer claim keeps the claim-card moving longer, one word step per word", () => {
    const short = revealMotionS({ spec: "claim-card", slots: { claim: "Small lanes win" } });
    const long = revealMotionS({ spec: "claim-card", slots: { claim: "Small lanes win again today" } });

    expect(long - short).toBeCloseTo(2 * CLAIM_WORD_EACH_S, 6);
  });

  it("an outro, which draws no action, stops moving once its line has risen; a button's action rises after it", () => {
    const outro = revealMotionS({ spec: "outro", slots: { line: "Answer the open question" } });
    const button = revealMotionS({ spec: "button", slots: { line: "Read the digest", action: "Open digest" } });

    expect(button - outro).toBeCloseTo(OUTRO_ACTION_S, 6);
  });

  it("times each reveal on react-ui's own MOTION durations and spring settle, unchanged by the node-safe tokens", () => {
    const quoted = { spec: "claim-card", slots: { claim: "Small", quote: "lanes" } };

    const times = [revealMotionS({ spec: "outro", slots: {} }), revealMotionS(quoted), revealMotionS({ spec: "stat", slots: {} })];

    const settleS = springSettleS(STAT_COUNT_SPRING, STAT_COUNT_VISIBLE);
    expect(STAT_COUNT_SETTLE_S).toBe(settleS);
    expect(times).toEqual([MOTION.duration.slow, CLAIM_WORDS_START_S + MOTION.duration.slow + (CLAIM_WORD_EACH_S + MOTION.duration.normal), Math.max(MOTION.duration.slow, STAT_COUNT_START_S + settleS)]);
  });
});
