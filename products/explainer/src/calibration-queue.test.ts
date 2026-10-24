import { describe, expect, it } from "vitest";
import { buildQueue, QueueKeySchema, type CalibrationJudge, type JudgedOutput } from "./calibration-queue.js";

const output = (judge: CalibrationJudge, n: number, over: Partial<JudgedOutput> = {}): JudgedOutput => ({
  case: "explainer-eval/a", videoType: "repo-tour", split: "dev", ownerNamed: false,
  judge, kind: "verdict", target: `${judge}-${n}`, question: `question ${judge} ${n}`, excerpt: `excerpt ${n}`, pass: n % 2 === 0, configId: "cfg", run: "1", evalVersion: `ev-${judge}`, ...over,
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

    const perJudge = (["cold", "cold-rubric", "l1"] as const).map((judge) => key.filter((k) => k.judge === judge).length);
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

    for (const item of items) expect(Object.keys(item).sort()).toEqual(["case", "excerpt", "id", "kind", "question"]);
    expect(items.map((i) => i.id)).toEqual(key.map((k) => k.id));
    expect(items[0]!.id).toBe("q01");
  });

  it("groups items by case so each video is read once", () => {
    const { items } = buildQueue(pool(), 20);

    const cases = items.map((i) => i.case);
    expect(cases).toEqual([...cases].sort());
  });

  it("asks a pair once, keeping an entry per picker under the question's id", () => {
    const pair = (judge: CalibrationJudge, pass: boolean) => output(judge, 0, { case: "explainer-eval/pairs", kind: "pair", group: "p1", target: "p1", pass });

    const { items, key } = buildQueue([pair("audition-code", true), pair("audition-rubric", false), ...many("cold", 3)], 20);

    const asked = items.filter((i) => i.kind === "pair");
    expect(asked).toHaveLength(1);
    expect(key.filter((k) => k.id === asked[0]!.id).map((k) => [k.judge, k.pass])).toEqual([["audition-code", true], ["audition-rubric", false]]);
  });

  it("gives pairs the pickers disagree on a slot even when agreeing pairs far outnumber them", () => {
    const pair = (n: number, code: boolean, rubric: boolean) => [
      output("audition-code", n, { kind: "pair", group: `p${n}`, target: `p${n}`, pass: code }),
      output("audition-rubric", n, { kind: "pair", group: `p${n}`, target: `p${n}`, pass: rubric }),
    ];
    const agreeing = Array.from({ length: 12 }, (_, n) => pair(n, n % 2 === 0, n % 2 === 0)).flat();

    const { key } = buildQueue([...agreeing, ...pair(99, true, false), ...many("cold", 20), ...many("l1", 20), ...many("cold-rubric", 20)], 20);

    expect(key.filter((k) => k.target === "p99").map((k) => k.judge)).toEqual(["audition-code", "audition-rubric"]);
  });

  it("puts the clearest video first, then the pairs, then the other videos from clearest to least clear", () => {
    const at = (name: string) => ({ case: `explainer-eval/${name}` });
    const outputs = [
      ...many("cold", 3, at("dense")), ...many("cold", 3, at("clear")), ...many("l1", 3, at("middling")), ...many("l1", 3, at("unscreened")),
      output("audition-code", 0, { ...at("pairs"), kind: "pair", group: "p0" }),
    ];
    const clarity = new Map([["explainer-eval/dense", 3], ["explainer-eval/clear", 1], ["explainer-eval/middling", 2]]);

    const { items } = buildQueue(outputs, 20, "s1", clarity);

    expect([...new Set(items.map((i) => i.case.split("/")[1]))]).toEqual(["clear", "pairs", "middling", "dense", "unscreened"]);
  });

  it("keys each entry with its judge's eval_version, and still reads a round-1 key that has none", () => {
    const { key } = buildQueue(many("cold", 2), 20);

    expect(key.map((k) => k.evalVersion)).toEqual(["ev-cold", "ev-cold"]);
    const roundOne = { schema: "calibration-key/v1", round: "r1", entries: [{ id: "q01", judge: "cold", case: "c", videoType: "repo-tour", target: "t", pass: true, configId: "", run: "1" }] };
    expect(QueueKeySchema.parse(roundOne).entries[0]!.evalVersion).toBeUndefined();
  });

  it("is reproducible for a seed and reshuffles for another", () => {
    const ids = (seed: string) => buildQueue(pool(), 20, seed).key.map((k) => k.target);

    expect(ids("s1")).toEqual(ids("s1"));
    expect(ids("s1")).not.toEqual(ids("s2"));
  });
});
