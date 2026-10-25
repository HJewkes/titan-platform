import { describe, expect, it } from "vitest";
import { listenerLabels } from "./calibration-agreement.js";
import { buildQueue, pickListenerItems, type CalibrationJudge, type JudgedOutput } from "./calibration-queue.js";

const BAR = 2.5;

const output = (judge: CalibrationJudge, n: number, over: Partial<JudgedOutput> = {}): JudgedOutput => ({
  case: "explainer-eval/a", videoType: "repo-tour", split: "dev", ownerNamed: false,
  judge, kind: "verdict", target: `${judge}-${n}`, question: `question ${n}`, excerpt: `excerpt ${n}`, pass: n % 2 === 0, configId: "cfg", run: "1", evalVersion: `ev-${judge}`, ...over,
});

const chapter = (name: string, density: number, over: Partial<JudgedOutput> = {}): JudgedOutput =>
  output("listener", 0, { kind: "listener", target: name, question: "Is this chapter clear enough to follow on one hearing?", pass: density <= BAR, density, evalVersion: "ev-listener", ...over });

describe("listener items", () => {
  it("picks the chapters nearest the bar, taking turns between ones that clear it and ones that do not", () => {
    const candidates = [chapter("far-clear", 0.5), chapter("near-clear", 2.4), chapter("at-bar", 2.5), chapter("near-dense", 2.8), chapter("far-dense", 5)];

    const picked = pickListenerItems(candidates, BAR);

    expect(picked.map((o) => o.target)).toEqual(["at-bar", "near-dense", "near-clear"]);
  });

  it("never picks a holdout or owner-named chapter", () => {
    const candidates = [chapter("held", 2.5, { split: "holdout" }), chapter("named", 2.6, { ownerNamed: true }), chapter("dev", 1)];

    expect(pickListenerItems(candidates, BAR).map((o) => o.target)).toEqual(["dev"]);
  });

  it("asks them on top of the queue's size, first in their video's section, clearest chapter first", () => {
    const listener = [chapter("ch2", 3), chapter("ch1", 2)];

    const { items, key } = buildQueue([...Array.from({ length: 6 }, (_, n) => output("cold", n))], 4, "s1", new Map(), listener);

    expect(items).toHaveLength(6);
    expect(items.slice(0, 2).map((i) => [i.kind, i.excerpt])).toEqual([["listener", "excerpt 0"], ["listener", "excerpt 0"]]);
    expect(key.slice(0, 2).map((k) => [k.target, k.density])).toEqual([["ch1", 2], ["ch2", 3]]);
  });

  it("turns the owner's yes and no into a row per chapter beside its density, leaving can't-tell and other judges out", () => {
    const { key } = buildQueue([output("cold", 0)], 20, "s1", new Map(), [chapter("ch1", 2), chapter("ch2", 3), chapter("ch3", 1)]);
    const id = (target: string) => key.find((k) => k.target === target)!.id;
    const labels = new Map([[id("ch1"), "yes"], [id("ch2"), "no"], [id("ch3"), "unsure"], [id("cold-0"), "yes"]] as const);

    const rows = listenerLabels(key, labels);

    expect(rows).toEqual([
      { case: "explainer-eval/a", chapter: "ch1", density: 2, clear: true, eval_version: "ev-listener" },
      { case: "explainer-eval/a", chapter: "ch2", density: 3, clear: false, eval_version: "ev-listener" },
    ]);
  });
});
