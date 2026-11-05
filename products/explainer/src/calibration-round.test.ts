import { describe, expect, it } from "vitest";
import { agreement } from "./calibration-agreement.js";
import { calibrationRound, sectionId } from "./calibration-round.js";
import { buildQueue, QueueKeySchema, type JudgedOutput } from "./calibration-queue.js";

/** The console's rule for section and question ids (round@2 schema). */
const CONSOLE_ID = /^[A-Za-z0-9_-]{1,32}$/;

const longSlug = "explainer-eval/synthetic-long-case-name-x"; // 41 characters

const output = (caseId: string, n: number): JudgedOutput => ({
  case: caseId, videoType: "repo-tour", split: "dev", ownerNamed: false, judge: "cold", kind: "verdict",
  target: `t-${n}`, question: `question ${n}`, excerpt: `excerpt ${n}`, pass: n % 2 === 0, configId: "cfg", run: "1", evalVersion: "ev",
});

describe("sectionId", () => {
  it("fits the console id rule for a 41-character slug, the same on every call", () => {
    const first = sectionId(longSlug);

    expect(longSlug).toHaveLength(41);
    expect(first).toMatch(CONSOLE_ID);
    expect(sectionId(longSlug)).toBe(first);
  });

  it("gives two long slugs sharing a 32-character prefix different ids", () => {
    const prefix = "explainer-eval/synthetic-long-ca";
    const a = sectionId(`${prefix}se-one`);
    const b = sectionId(`${prefix}se-two`);

    expect(a).not.toBe(b);
  });

  it("keeps a short slug readable and unhashed", () => {
    const id = sectionId("explainer-eval/a");

    expect(id).toBe("case-explainer-eval-a");
  });

  it("does not collide across a set of distinct long slugs", () => {
    const slugs = Array.from({ length: 200 }, (_, n) => `explainer-eval/synthetic-shared-prefix-${n}`);

    const ids = new Set(slugs.map(sectionId));

    expect(ids.size).toBe(slugs.length);
    for (const id of ids) expect(id).toMatch(CONSOLE_ID);
  });
});

describe("calibrationRound", () => {
  it("gives every section and question id a queue builds a console-valid form", () => {
    const outputs = [...Array.from({ length: 6 }, (_, n) => output(longSlug, n)), ...Array.from({ length: 6 }, (_, n) => output("explainer-eval/short", n))];
    const queue = buildQueue(outputs, 12);

    const round = calibrationRound(queue, { unit: "synthetic-unit", round: 1, cases: new Map() });

    const ids = [...round.sections.map((s) => s.id), ...round.questions.map((q) => q.id), ...round.sections.flatMap((s) => s.questionIds)];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(CONSOLE_ID);
  });
});

describe("round-1 key entries", () => {
  it("parse without configId or run, and agreement runs on them", () => {
    const entry = { id: "q01", judge: "cold", case: "c", videoType: "repo-tour", target: "t", pass: true };
    const parsed = QueueKeySchema.parse({ schema: "calibration-key/v1", round: "r1", entries: [entry] });

    const rows = agreement(parsed.entries, new Map([["q01", "yes" as const]]));

    expect(rows.find((r) => r.judge === "cold")).toMatchObject({ labelled: 1, agreed: 1 });
  });
});
