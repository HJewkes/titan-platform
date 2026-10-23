import { describe, expect, it } from "vitest";
import { buildQueue, CALIBRATION_JUDGES, type CalibrationJudge, type JudgedOutput } from "./calibration-queue.js";

const output = (judge: CalibrationJudge, n: number, over: Partial<JudgedOutput> = {}): JudgedOutput => ({
  case: "explainer-eval/a", videoType: "repo-tour", split: "dev", ownerNamed: false,
  judge, target: `${judge}-${n}`, question: `question ${judge} ${n}`, excerpt: `excerpt ${n}`, pass: n % 2 === 0, ...over,
});

const many = (judge: CalibrationJudge, count: number, over: Partial<JudgedOutput> = {}): JudgedOutput[] =>
  Array.from({ length: count }, (_, n) => output(judge, n, over));

const pool = (): JudgedOutput[] => [
  ...many("cold", 40),
  ...many("cold-rubric", 5),
  ...many("l1", 30),
  ...many("cold", 10, { case: "explainer-eval/b", videoType: "status" }),
  ...many("l1", 10, { case: "explainer-eval/b", videoType: "status" }),
];

describe("buildQueue", () => {
  it("draws about evenly across judges even when one judge has eight times the outputs", () => {
    const { key } = buildQueue(pool(), 20);

    const perJudge = CALIBRATION_JUDGES.map((judge) => key.filter((k) => k.judge === judge).length);
    expect(perJudge.reduce((a, b) => a + b)).toBe(20);
    expect(Math.min(...perJudge)).toBeGreaterThanOrEqual(5);
  });

  it("mixes video types and both verdicts for every judge with both on offer", () => {
    const { key } = buildQueue(pool(), 20);

    expect(new Set(key.map((k) => k.videoType))).toEqual(new Set(["repo-tour", "status"]));
    for (const judge of ["cold", "l1"] as const) {
      expect(new Set(key.filter((k) => k.judge === judge).map((k) => k.pass)), judge).toEqual(new Set([true, false]));
    }
  });

  it("never queues a holdout or owner-named output", () => {
    const held = [...many("cold", 30, { case: "explainer-eval/held", split: "holdout" }), ...many("l1", 30, { case: "explainer-eval/named", ownerNamed: true })];

    const { key } = buildQueue([...held, ...many("cold-rubric", 3)], 20);

    expect(key.map((k) => k.case)).toEqual(["explainer-eval/a", "explainer-eval/a", "explainer-eval/a"]);
  });

  it("hides the judge and its verdict from the items the owner sees, keeping them in the key by id", () => {
    const { items, key } = buildQueue(pool(), 20);

    for (const item of items) expect(Object.keys(item).sort()).toEqual(["case", "excerpt", "id", "question"]);
    expect(items.map((i) => i.id)).toEqual(key.map((k) => k.id));
    expect(items[0]!.id).toBe("q01");
  });

  it("groups items by case so each video is read once", () => {
    const { items } = buildQueue(pool(), 20);

    const cases = items.map((i) => i.case);
    expect(cases).toEqual([...cases].sort());
  });

  it("is reproducible for a seed and reshuffles for another", () => {
    const ids = (seed: string) => buildQueue(pool(), 20, seed).key.map((k) => k.target);

    expect(ids("s1")).toEqual(ids("s1"));
    expect(ids("s1")).not.toEqual(ids("s2"));
  });
});
