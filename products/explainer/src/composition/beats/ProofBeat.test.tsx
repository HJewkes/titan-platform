import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { resolveBeat } from "../registry.js";
import { ProofKindBeat } from "./ProofBeat.js";
import { revealFrom } from "./stage/reveal.js";

/** Synthetic: one check the change fixes, one it keeps green. */
const CHECKS = [
  { id: "checks-1", name: "parcel-sort", base: "fail", head: "pass" },
  { id: "checks-2", name: "label-print", base: "pass", head: "pass" },
];
const CUE_S = 2;
const SETTLED_S = 5;

function htmlAt(t: number, checks: unknown = CHECKS): string {
  const slots = BEAT_SLOTS.proof.parse({ command: "pnpm test", checks });
  return renderToStaticMarkup(
    <MotionProvider clock={seekClock(t)}>
      <Beat startS={0} durationS={8}>
        <ProofKindBeat slots={slots} reveal={revealFrom([{ target: "checks-1", atS: CUE_S }])} hints={{}} />
      </Beat>
    </MotionProvider>,
  );
}

/** The state each chip's accessible name reports, in row order. */
const statesAt = (t: number): string[] => [...htmlAt(t).matchAll(/aria-label="[^"]*: (met|unmet)"/g)].map((m) => m[1]!);

describe("a proof beat's check rows", () => {
  it("a check that fails at base is unmet before its cue and met once its move has run", () => {
    // Arrange
    const before = 1;

    // Act
    const [first] = [statesAt(before)[0], statesAt(SETTLED_S)[0]];

    // Assert
    expect(first).toBe("unmet");
    expect(statesAt(SETTLED_S)[0]).toBe("met");
  });

  it("a check that passes at base and head is met at every sampled t", () => {
    // Arrange
    const samples = [0, 1, 2, 2.3, 5];

    // Act
    const shown = samples.map((t) => statesAt(t)[1]);

    // Assert
    expect(shown).toEqual(samples.map(() => "met"));
  });

  it("markup at a sampled t does not depend on the order the samples were rendered in", () => {
    // Arrange
    const samples = [0, 1.5, 2.2, 3, 5];
    const ascending = samples.map((t) => htmlAt(t));

    // Act
    const scrambled = [3, 0, 5, 2.2, 1.5].map((t) => [t, htmlAt(t)] as const);

    // Assert
    for (const [t, html] of scrambled) expect(html).toBe(ascending[samples.indexOf(t)]);
  });

  it("shows the command line when one is present", () => {
    expect(htmlAt(0)).toContain("pnpm test");
  });
});

describe("the proof beat's slots", () => {
  it("rejects a beat with no checks", () => {
    expect(() => resolveBeat("proof").slots.parse({ checks: [] })).toThrow();
  });
});
