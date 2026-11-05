import assert from "node:assert/strict";
import { cubicBezier, MOTION, type Easing } from "@titan-design/react-ui/motion";
import { describe, test } from "vitest";

/**
 * The spike beats were tuned against titan's MOTION as it stood at react-ui 0.21: durations 0.15/0.25/0.4 s and these
 * curves. The ported beats read MOTION.duration and MOTION.ease.out/inOut from react-ui, so a token change there would
 * move every entrance without a diff here. react-ui's ease.spring no longer overshoots; a port that wants the spike's
 * overshoot (0.34, 1.56, 0.64, 1) writes that curve out instead of reading MOTION.ease.spring.
 */
const SPIKE = {
  duration: { fast: 0.15, normal: 0.25, slow: 0.4 },
  ease: { out: [0.22, 1, 0.36, 1], inOut: [0.65, 0, 0.35, 1] },
} as const;

const SAMPLES = [0.1, 0.25, 0.5, 0.75, 0.9];

const sampled = (ease: Easing) => SAMPLES.map((p) => Number(ease(p).toFixed(4)));

describe("the MOTION tokens the ported stage beats use", () => {
  test("durations are the spike's", () => {
    const { fast, normal, slow } = MOTION.duration;

    assert.deepEqual({ fast, normal, slow }, SPIKE.duration);
  });

  test("ease.out traces the spike's out curve", () => {
    const [x1, y1, x2, y2] = SPIKE.ease.out;

    assert.deepEqual(sampled(MOTION.ease.out), sampled(cubicBezier(x1, y1, x2, y2)));
  });

  test("ease.inOut traces the spike's in-out curve", () => {
    const [x1, y1, x2, y2] = SPIKE.ease.inOut;

    assert.deepEqual(sampled(MOTION.ease.inOut), sampled(cubicBezier(x1, y1, x2, y2)));
  });
});
