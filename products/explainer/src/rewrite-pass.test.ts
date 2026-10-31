import { describe, expect, it } from "vitest";
import { usePreCalibrationStatuses } from "./writing-statuses-fixtures.test-helpers.js";
import type { JudgeHarness } from "./eval-harness.js";
import { runL0, type L0Result } from "./eval-l0.js";
import { registerCheck } from "./lint-register.js";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { bandDistance, chapterRefusal, rewriteScript } from "./rewrite-pass.js";
import { REWRITE_TARGET_ROWS } from "./rewrite-plan.js";
import { hasSpokenDigits, spellSpokenNumbers } from "./spoken-numbers.js";
import type { ScriptV1 } from "./script-schema.js";
import { BEATS, cuedChoppy, compliant, fakeRewriter, promptBeatIds, REWRITES, type Rewriter } from "./rewrite-fixtures.test-helpers.js";

// These tests pin the mechanics on fixtures; the shipped status table is data a recalibration changes (TP-4662).
usePreCalibrationStatuses();

const isRoundTwo = (prompt: string): boolean => prompt.includes("Change only what the lines above name");

const rewrite = (script: ScriptV1, fake = fakeRewriter(), options: { rounds?: number } = {}) =>
  rewriteScript(script, { harness: fake.harness, judge: sonnet, ...options });

const targets = (s: ScriptV1) => runL0(s, undefined, [registerCheck]).filter((row) => (REWRITE_TARGET_ROWS as readonly string[]).includes(row.check_id));
const failingTargets = (s: ScriptV1): string[] => targets(s).filter((row) => !row.pass).map((row) => row.check_id);
const spokenOf = (s: ScriptV1, id: string): string => s.beats.find((beat) => beat.id === id)!.spoken;
const spellAll = (s: ScriptV1): ScriptV1 => ({ ...s, beats: s.beats.map(spellSpokenNumbers) });
const labelsOf = (s: ScriptV1, id: string): string[] => s.beats.find((beat) => beat.id === id)!.visual.labels;

describe("rewriteScript with compliant rewrites", () => {
  it("brings all five target rows into band and cuts the extra numbers without putting them on screen", async () => {
    const script = cuedChoppy();

    const { script: out, report } = await rewrite(script);

    expect(failingTargets(script).sort()).toEqual([...REWRITE_TARGET_ROWS].sort());
    expect(failingTargets(out)).toEqual([]);
    expect(report.rounds[0]).toMatchObject({ kept: true, rejected: [], reverted: [] });
    expect(report.after.every((row) => row.pass)).toBe(true);
    expect(report.before.filter((row) => !row.pass)).toHaveLength(5);
    expect(out.beats.flatMap((beat) => beat.visual.labels)).toEqual([]);
    expect(spokenOf(out, "h2")).not.toMatch(/\bthree\b/);
  });

  it("keeps every beat's fact ids and spells the numbers it still speaks", async () => {
    const script = cuedChoppy();

    const { script: out } = await rewrite(script);

    expect(out.beats.map((beat) => beat.fact_ids)).toEqual(script.beats.map((beat) => beat.fact_ids));
    expect(out.beats.filter((beat) => hasSpokenDigits(beat.spoken))).toEqual([]);
    expect(spokenOf(out, "h2")).toContain("The desk held twelve parcels today.");
  });

  it("stops after the round that brings every target row into band, and sums the spend of each call", async () => {
    const fake = fakeRewriter();

    const { report } = await rewrite(cuedChoppy(), fake);

    expect(report.rounds.map((round) => round.round)).toEqual([1]);
    expect(report.calls.map((call) => call.chapter)).toEqual(["ch1", "ch2", "ch3", "ch4"]);
    expect(report.usd).toBeCloseTo(0.04);
    expect(report.tokensIn).toBe(1600);
    expect(report.tokensOut).toBe(480);
    expect(report.judge).toBe("claude-print:sonnet");
  });

  it("makes no call for a script whose target rows already pass", async () => {
    const fake = fakeRewriter();
    const { script: done } = await rewrite(cuedChoppy(), fake);
    const again = fakeRewriter();

    const { report } = await rewrite(done, again);

    expect(again.prompts).toEqual([]);
    expect(report.rounds).toEqual([]);
  });
});

describe("rewriteScript guard and revert", () => {
  it("keeps a beat whose rewrite cuts the number a cue lands on, and reports the lost cue", async () => {
    const cue = { visual: { assertion: "The ledger holds rows per dock", job: "map", cues: [{ action: "V6", target: "n1", atCue: "50" }] } };

    const { script: out, report } = await rewrite(cuedChoppy({ w4: cue }), fakeRewriter(), { rounds: 1 });

    expect(report.rounds[0]!.rewritten).not.toContain("w4");
    expect(report.rounds[0]!.rejected.find((r) => r.beat === "w4")!.rejections).toContainEqual(expect.objectContaining({ rule: "cue-lost" }));
    expect(spokenOf(out, "w4")).toBe(spokenOf(spellAll(cuedChoppy({ w4: cue })), "w4"));
  });

  it("keeps a beat whose rewrite drops a cue word, and reports why", async () => {
    const cue = { visual: { assertion: "The ledger names a dock", job: "map", cues: [{ action: "V6", target: "n1", atCue: "dock" }] } };
    const script = cuedChoppy({ w2: cue });
    const breaksCue: Rewriter = (id, prompt) => {
      const reply = compliant(id, prompt)!;
      return id === "w2" ? { ...reply, spoken: reply.spoken.replace("dock", "bay") } : reply;
    };

    const { script: out, report } = await rewrite(script, fakeRewriter(breaksCue), { rounds: 1 });

    expect(spokenOf(out, "w2")).toBe(BEATS.w2![1].before);
    expect(report.rounds[0]!.rejected.map((r) => r.beat)).toEqual(["w2"]);
    expect(report.rounds[0]!.rejected[0]!.rejections).toContainEqual({ rule: "cue-lost", detail: 'cue "dock" is no longer spoken' });
    expect(report.rounds[0]!.rejected[0]!.candidate).toEqual({
      spoken: BEATS.w2![1].after.replace("dock", "bay"),
      labels_added: [],
    });
    expect(report.rounds[0]!.rewritten).not.toContain("w2");
  });

  it("reverts a beat whose rewrite gains an error row, and keeps the rest of the round", async () => {
    const addsBannedWord: Rewriter = (id, prompt) => {
      const reply = compliant(id, prompt)!;
      return id === "k3" ? { ...reply, spoken: reply.spoken.replace("The desk can wait.", "The desk can simply wait.") } : reply;
    };

    const { script: out, report } = await rewrite(cuedChoppy(), fakeRewriter(addsBannedWord), { rounds: 1 });

    expect(report.rounds[0]!.reverted).toEqual([{ beat: "k3", rows: ["Q-V7"] }]);
    expect(spokenOf(out, "k3")).toBe(BEATS.k3![1].before);
    expect(report.rounds[0]!.kept).toBe(true);
    expect(spokenOf(out, "k2")).toContain("at the counter");
  });

  it("re-declares a reading the rewrite dropped, so the beat is kept rather than reverted for Q-V10", async () => {
    // Catches: a rewrite reply judged with its `[w](=reading)` markup dropped, which turns Q-V10 red and reverts the beat.
    const draft = cuedChoppy();
    const declared = { ...draft, beats: draft.beats.map((beat) => (beat.id === "w1" ? { ...beat, spoken: beat.spoken.replace("a minute", "in 2 [minutes](=time)") } : beat)) };
    const dropsDeclaration: Rewriter = (id, prompt) => {
      const reply = compliant(id, prompt)!;
      return id === "w1" ? { ...reply, spoken: reply.spoken.replace("a minute", "in 2 minutes") } : reply;
    };

    const { script: out, report } = await rewrite(declared, fakeRewriter(dropsDeclaration), { rounds: 1 });

    expect(spokenOf(out, "w1")).toContain("in two [minutes](=time) to the desk server");
    expect(report.rounds[0]!.reverted.map((entry) => entry.beat)).not.toContain("w1");
  });

  // k3 speaks 20 words and its rewrite 26, in a concept beat at 2.8 w/s: 8 s caps it at 22 words, 10 s at 28.
  it("reverts a beat whose rewrite takes it over its word cap, and keeps the rest of the round", async () => {
    const script = cuedChoppy({ k3: { plannedS: 8 } });

    const { script: out, report } = await rewrite(script, fakeRewriter(), { rounds: 1 });

    expect(report.rounds[0]!.reverted).toEqual([{ beat: "k3", rows: ["word-budget"] }]);
    expect(spokenOf(out, "k3")).toBe(BEATS.k3![1].before);
    expect(spokenOf(out, "k2")).toContain("at the counter");
  });

  // Synthetic counter rows; the list slot schema holds five, so a sixth appended label leaves no row for it.
  it("reverts a beat whose appended label gives its 5-row list a sixth row the template fill refuses", async () => {
    // Arrange
    const rows = ["desk · Parcels in", "desk · Parcels out", "desk · Holds", "desk · Returns", "desk · Couriers"];
    const draft = cuedChoppy();
    const script = { ...draft, beats: draft.beats.map((beat) => (beat.id === "k3" ? { ...beat, visual: { ...beat.visual, beat: "list", labels: rows } } : beat)) };
    const addsRow: Rewriter = (id, prompt) => {
      const reply = compliant(id, prompt)!;
      return id === "k3" ? { ...reply, labels_added: ["desk · Night shift"] } : reply;
    };

    // Act
    const { script: out, report } = await rewrite(script, fakeRewriter(addsRow), { rounds: 1 });

    // Assert: a beat the fill refuses also fails the drawn-model Q-D15 (TP-4506), which runs on every type.
    expect(report.rounds[0]!.reverted).toEqual([{ beat: "k3", rows: ["Q-D15", "template-fill"] }]);
    expect(labelsOf(out, "k3")).toEqual(rows);
    expect(spokenOf(out, "k2")).toContain("at the counter");
  });

  it("keeps a rewrite that grows a beat within its word cap", async () => {
    const script = cuedChoppy({ k3: { plannedS: 10 } });

    const { script: out, report } = await rewrite(script, fakeRewriter(), { rounds: 1 });

    expect(report.rounds[0]!.reverted).toEqual([]);
    expect(spokenOf(out, "k3")).toBe(BEATS.k3![1].after);
  });

  // The goals block caps at 70 words (25 s at 2.8 w/s); ch4's three beats speak 68, and the compliant c1 and c2 add 6.
  it("reverts the beats that grew a profile block past its cap, and not the one that shrank", async () => {
    const draft = cuedChoppy();
    const asBlock = (chapter: string): string => (chapter === "ch4" ? "goals" : chapter);
    const script: ScriptV1 = {
      ...draft,
      profile: "daily-overview",
      chapters: draft.chapters.map((chapter) => ({ ...chapter, id: asBlock(chapter.id) })),
      beats: draft.beats.map((beat) => ({ ...beat, chapter: asBlock(beat.chapter) })),
    };
    const shortC3 = BEATS.c3![1].before.replace("first, then", "then");
    const shrinksC3: Rewriter = (id, prompt) => (id === "c3" ? { id, spoken: shortC3, labels_added: [] } : compliant(id, prompt));

    const { script: out, report } = await rewrite(script, fakeRewriter(shrinksC3), { rounds: 1 });

    // A daily-overview script also gets TP-4470's script preflight rows, which revert other beats for their own reasons.
    const overBudget = report.rounds[0]!.reverted.filter((beat) => beat.rows.includes("word-budget")).map((beat) => beat.beat);
    expect(overBudget).toEqual(["c1", "c2"]);
    expect(spokenOf(out, "c1")).toBe(spokenOf(spellAll(script), "c1"));
  });

  it("reports a skipped beat as missing and leaves it as written", async () => {
    const skipsH1: Rewriter = (id, prompt) => (id === "h1" ? undefined : compliant(id, prompt));

    const { script: out, report } = await rewrite(cuedChoppy(), fakeRewriter(skipsH1), { rounds: 1 });

    expect(spokenOf(out, "h1")).toBe(BEATS.h1![1].before);
    expect(report.rounds[0]!.rejected).toEqual([{ beat: "h1", rejections: [expect.objectContaining({ rule: "missing" })] }]);
    expect(report.rounds[0]!.rejected[0]).not.toHaveProperty("candidate");
  });
});

describe("rewriteScript fails closed", () => {
  it("leaves a failed call's chapter unchanged, reports it, and does not retry it", async () => {
    const fake = fakeRewriter(compliant, (prompt) => (prompt.includes("# Chapter ch2") ? "budget_exceeded: over cap" : undefined));

    const { script: out, report } = await rewrite(cuedChoppy(), fake, { rounds: 1 });

    expect(spokenOf(out, "w1")).toContain("forty scans a minute. The desk server takes two seconds");
    expect(spokenOf(out, "w2")).toBe(BEATS.w2![1].before);
    expect(labelsOf(out, "w1")).toEqual([]);
    expect(fake.prompts.filter((prompt) => prompt.includes("# Chapter ch2"))).toHaveLength(1);
    expect(report.calls.find((call) => call.chapter === "ch2")).toMatchObject({ ok: false, reason: "budget_exceeded: over cap", usd: 0.002 });
    expect(report.rounds[0]!.rejected).toEqual([]);
    expect(spokenOf(out, "h1")).toBe(BEATS.h1![1].after);
  });

  it("treats a call that throws as failed", async () => {
    const harness: JudgeHarness = async () => {
      throw new Error("claude exited 1");
    };

    const { script: out, report } = await rewriteScript(cuedChoppy(), { harness, judge: sonnet, rounds: 1 });

    expect(report.calls.every((call) => !call.ok && call.reason === "claude exited 1")).toBe(true);
    expect(out.beats.map((beat) => beat.visual.labels)).toEqual(out.beats.map(() => []));
    expect(spokenOf(out, "h1")).toBe(BEATS.h1![1].before);
  });
});

describe("rewriteScript rounds", () => {
  it("discards a round that moves the script further from band, keeping the text before it", async () => {
    const clipped: Rewriter = (id) => ({ id, spoken: REWRITES.get(id)!.before.replace(/ the /g, " "), labels_added: [] });

    const { script: out, report } = await rewrite(cuedChoppy(), fakeRewriter(clipped));

    expect(report.rounds.map((round) => [round.round, round.kept])).toEqual([[1, false], [2, false]]);
    expect(report.rounds[0]!.why).toBe("every chapter was reverted");
    expect(report.rounds[0]!.chapters.map((verdict) => verdict.why)).toEqual(report.rounds[0]!.chapters.map(() => "the distance to band did not fall"));
    expect(spokenOf(out, "h1")).toBe(BEATS.h1![1].before);
  });

  it("runs round 2 on round 1's text, only for beats still holding a triad or crowded numbers", async () => {
    const leavesTriad: Rewriter = (id, prompt) => {
      if (id === "c2" && !isRoundTwo(prompt)) return { id, spoken: BEATS.c2![1].before.replace("That order matters.", "That order matters a lot."), labels_added: [] };
      return compliant(id, prompt);
    };
    const fake = fakeRewriter(leavesTriad);

    const { script: out, report } = await rewrite(cuedChoppy(), fake);

    const roundTwo = fake.prompts.filter(isRoundTwo);
    expect(report.rounds.map((round) => round.kept)).toEqual([true, true]);
    expect(roundTwo.map(promptBeatIds)).toEqual([["c2"]]);
    expect(roundTwo[0]).toContain("That order matters a lot.");
    expect(spokenOf(out, "c2")).toBe(BEATS.c2![1].after);
    expect(failingTargets(out)).toEqual([]);
  });

  it("tells round 2 why round 1 refused a beat, and says nothing to a beat round 1 accepted", async () => {
    const LONG_H3 = "It checks the scan and the row before the label, so nothing is skipped and the courier never sees a guess and the check is always fast.";
    const refusesH3KeepsC2: Rewriter = (id, prompt) => {
      if (isRoundTwo(prompt)) return compliant(id, prompt);
      if (id === "h3") return { id, spoken: LONG_H3, labels_added: [] };
      if (id === "c2") return { id, spoken: BEATS.c2![1].before.replace("That order matters.", "That order matters a lot."), labels_added: [] };
      return compliant(id, prompt);
    };
    const fake = fakeRewriter(refusesH3KeepsC2);

    const { report } = await rewrite(cuedChoppy(), fake);

    const sectionOf = (id: string): string => fake.prompts.filter(isRoundTwo).flatMap((prompt) => prompt.split("\n\n")).find((part) => part.startsWith(`## ${id}\n`))!;
    expect(report.rounds[0]!.rejected.map((r) => [r.beat, r.rejections.map((rejection) => rejection.rule)])).toEqual([["h3", ["sentence-cap"]]]);
    expect(report.rounds[0]!.rewritten).toContain("c2");
    expect(sectionOf("h3")).toContain("- Your last version was not used: a sentence was too long to say in one breath; split it.");
    expect(sectionOf("c2")).toContain("Directive:");
    expect(sectionOf("c2")).not.toContain("Your last version was not used");
  });

  it("stops after the rounds it is given", async () => {
    const fake = fakeRewriter(() => undefined);

    const { report } = await rewrite(cuedChoppy(), fake, { rounds: 1 });

    expect(report.rounds.map((round) => round.round)).toEqual([1]);
  });

  it("refuses a round count outside 1..2", async () => {
    await expect(rewrite(cuedChoppy(), fakeRewriter(), { rounds: 3 })).rejects.toThrow(RangeError);
    await expect(rewrite(cuedChoppy(), fakeRewriter(), { rounds: 0 })).rejects.toThrow(RangeError);
  });
});

describe("rewriteScript with a speech verdict", () => {
  const LONG = "The desk refuses ghost labels. When a courier at the front counter asks for a label, the desk looks for the parcel row in the ledger and waits for that answer before it prints.";

  it("keeps a vetted long sentence that the plain cap would refuse", async () => {
    const longH1: Rewriter = (id, prompt) => (id === "h1" ? { id, spoken: LONG, labels_added: [] } : compliant(id, prompt));

    // LONG is 34 words, so h1 gets the seconds to speak it.
    const roomy = (): ScriptV1 => cuedChoppy({ h1: { plannedS: 13 } });
    const plain = await rewrite(roomy(), fakeRewriter(longH1), { rounds: 1 });
    const vetted = await rewriteScript(roomy(), { harness: fakeRewriter(longH1).harness, judge: sonnet, rounds: 1, speechClean: () => true });

    expect(plain.report.rounds[0]!.rejected.map((r) => r.beat)).toEqual(["h1"]);
    expect(spokenOf(vetted.script, "h1")).toBe(LONG);
    expect(vetted.report.rounds[0]!.reverted).toEqual([]);
  });
});

const row = (check_id: string, value: number, threshold: number, pass: boolean, severity: "error" | "warning" = "warning"): L0Result => ({
  check_id, mode: "heuristic", severity, value, threshold, pass, detail_beats: [],
});

describe("chapterRefusal", () => {
  const before = [
    row("register:sentence-mean", 6, 12.51, false), row("register:numbers", 18, 25.62, true), row("register:contractions", 12, 40.18, true), row("Q-V7", 0, 0, true, "error"),
  ];
  const after = (changes: L0Result[]): L0Result[] => before.map((r) => changes.find((c) => c.check_id === r.check_id) ?? r);
  const closer = row("register:sentence-mean", 10, 12.51, false);
  const guarded = new Set(["register:contractions"]);

  it("keeps a chapter that comes closer to band without turning a row red", () => {
    expect(chapterRefusal(before, after([closer]), guarded)).toBeUndefined();
  });

  it("names the target row a chapter turns red, even when the distance falls", () => {
    const flipped = after([row("register:sentence-mean", 12, 12.51, false), row("register:numbers", 26, 25.62, false)]);
    expect(bandDistance(flipped)).toBeLessThan(bandDistance(before));
    expect(chapterRefusal(before, flipped, guarded)).toEqual({ why: "more target rows fail", rows: ["register:numbers"] });
  });

  it("refuses a chapter whose distance to band does not fall", () => {
    expect(chapterRefusal(before, before, guarded)).toEqual({ why: "the distance to band did not fall" });
  });

  it("names the error row a chapter turns red", () => {
    expect(chapterRefusal(before, after([closer, row("Q-V7", 1, 0, false, "error")]), guarded)).toEqual({ why: "more error rows fail", rows: ["Q-V7"] });
  });

  it("names a protected row that was green and turns red", () => {
    expect(chapterRefusal(before, after([closer, row("register:contractions", 9, 10.79, false)]), guarded)).toEqual({ why: "a protected row turned red", rows: ["register:contractions"] });
  });

  it("lets a protected row that was already red stay red", () => {
    const red = row("register:contractions", 4, 10.79, false);
    const redBefore = before.map((r) => (r.check_id === red.check_id ? red : r));
    expect(chapterRefusal(redBefore, redBefore.map((r) => (r.check_id === closer.check_id ? closer : r)), guarded)).toBeUndefined();
  });
});

// Every beat is in its compliant form except two that hold a triad (k1 in ch3, c2 in ch4): only triads fails, and sentence-mean sits just over its floor.
const NEAR_BAND: Record<string, string> = {
  k1: "It holds the rest. A row can be fresh, stale or missing, and the desk reads that state and prints only when it is fresh.",
  c2: "That order matters. It reads the scan, checks the row and prints the label, so the courier and the dock can trust it.",
};
const nearBand = (spoken: Record<string, string> = {}): ScriptV1 =>
  cuedChoppy(Object.fromEntries(Object.entries(BEATS).map(([id, [, rewrite]]) => [id, {
    spoken: spoken[id] ?? NEAR_BAND[id] ?? rewrite.after,
    visual: { assertion: "The desk refuses unknown parcels", job: "numbers", labels: [] },
  }])));
const answering = (replies: Record<string, string>): Rewriter => (id) => (replies[id] ? { id, spoken: replies[id], labels_added: [] } : undefined);

describe("rewriteScript keeps or reverts each chapter", () => {
  // Keeps k1's triad but chops its one long sentence into short ones, which pulls sentence-mean under its floor.
  const CHOPPED_K1 = "It holds the rest. A row can be fresh, stale or missing. The desk reads that state. It prints only when it is fresh.";
  const flipsMean = answering({ k1: CHOPPED_K1, c2: BEATS.c2![1].after });

  it("keeps the chapter that comes closer to band and reverts the sibling that turns a green row red, naming it", async () => {
    const script = nearBand();

    const { script: out, report } = await rewrite(script, fakeRewriter(flipsMean), { rounds: 1 });

    expect(report.rounds[0]!.chapters).toEqual([
      { chapter: "ch4", kept: true },
      { chapter: "ch3", kept: false, why: "more target rows fail", rows: ["register:sentence-mean"], candidates: [{ beat: "k1", spoken: CHOPPED_K1, labels_added: [] }] },
    ]);
    expect(spokenOf(out, "c2")).toBe(BEATS.c2![1].after);
    expect(spokenOf(out, "k1")).toBe(NEAR_BAND.k1);
    expect(report.rounds[0]).toMatchObject({ kept: true, rewritten: ["c2"], failing: { before: 1, after: 1 } });
    expect(report.rounds[0]!.distance.after).toBeLessThan(report.rounds[0]!.distance.before);
  });

  it("stores each accepted beat's candidate on the chapter it reverted, and none on the chapter it kept", async () => {
    const { report } = await rewrite(nearBand(), fakeRewriter(flipsMean), { rounds: 1 });

    const [kept, reverted] = report.rounds[0]!.chapters;
    expect(kept).not.toHaveProperty("candidates");
    expect(reverted!.candidates).toEqual([{ beat: "k1", spoken: CHOPPED_K1, labels_added: [] }]);
  });

  it("keeps the good chapter of a round the whole-round rule would have thrown away", async () => {
    const script = nearBand();
    const together = runL0(nearBand({ k1: CHOPPED_K1, c2: BEATS.c2![1].after }));

    const { script: out } = await rewrite(script, fakeRewriter(flipsMean), { rounds: 1 });

    expect(chapterRefusal(runL0(script), together, new Set())?.why).toBe("more target rows fail");
    expect(spokenOf(out, "c2")).toBe(BEATS.c2![1].after);
  });

  it("runs round 2 on the chapters round 1 kept", async () => {
    const fake = fakeRewriter((id, prompt) => (isRoundTwo(prompt) ? compliant(id, prompt) : flipsMean(id, prompt)));

    const { script: out, report } = await rewrite(nearBand(), fake);

    const roundTwo = fake.prompts.filter(isRoundTwo);
    expect(roundTwo.map(promptBeatIds)).toEqual([["k1"]]);
    expect(roundTwo[0]).toContain(NEAR_BAND.k1);
    expect(report.rounds[1]!.chapters).toEqual([{ chapter: "ch3", kept: true }]);
    expect(spokenOf(out, "k1")).toBe(BEATS.k1![1].after);
  });

  it("reverts a chapter that turns an error row red without naming its beat", async () => {
    // An identifier in w2 sits just past the plain-opening floor; a longer c2 pushes it under, and Q-F16 names w2, not c2.
    const w2 = "The desk reads both. The ledger keeps a row per parcel, and that row names the dock and the courier in parcelRows that will carry it.";
    const longerC2 = "That order matters to the desk. It reads the scan and checks the row in the ledger before it prints the label, so the courier and the dock can trust it.";

    const script = { ...nearBand({ w2 }) };
    // Held, so the fill floor its shorter line misses does not go green with the longer one and offset Q-F16.
    script.beats = script.beats.map((beat) => (beat.id === "c2" ? { ...beat, plannedS: 12, heldS: 1 } : beat));

    const { script: out, report } = await rewrite(script, fakeRewriter(answering({ c2: longerC2 })), { rounds: 1 });

    expect(report.rounds[0]!.reverted).toEqual([]);
    expect(report.rounds[0]!.chapters).toEqual([
      { chapter: "ch4", kept: false, why: "more error rows fail", rows: ["Q-F16"], candidates: [{ beat: "c2", spoken: longerC2, labels_added: [] }] },
    ]);
    expect(spokenOf(out, "c2")).toBe(NEAR_BAND.c2);
  });

  it("reverts a chapter that drops the script's contractions under their floor", async () => {
    const contracted = { h1: "The desk won't print ghost labels. When a courier asks for a label, the desk looks for the parcel row and waits for the ledger before it prints.",
      h3: "It checks the scan and the row before the label, so nothing's skipped and the courier never sees a guess. The check is fast.",
      k3: "The desk can wait. A refusal isn't an error, because the parcel may be late and its scan may still come later in the day.",
      k1: "It holds the rest. A row can be fresh, stale or missing, and the desk reads that state and prints only when it's fresh." };
    const script = nearBand(contracted);
    const spelledOutK1 = "It holds the rest. A row can be fresh or stale or missing, and the desk reads that state and prints only when it is fresh.";
    const spelledOut = answering({ k1: spelledOutK1 });

    const { script: out, report } = await rewrite(script, fakeRewriter(spelledOut), { rounds: 1 });

    expect(runL0(script).find((r) => r.check_id === "register:contractions")!.pass).toBe(true);
    expect(report.rounds[0]!.chapters).toEqual([
      { chapter: "ch3", kept: false, why: "a protected row turned red", rows: ["register:contractions"], candidates: [{ beat: "k1", spoken: spelledOutK1, labels_added: [] }] },
    ]);
    expect(spokenOf(out, "k1")).toBe(contracted.k1);
  });
});

describe("rewriteScript spells before it vets", () => {
  // 24 words as written, 27 once "1%" and "100%" are spelled.
  const DIGITS = "The desk held 12 parcels today and sent 3 back because 1% lacked a ledger row while 100% of the rest left on time.";
  const SPELLED_WORDS = 27;
  const rewriteH2: Rewriter = (id, prompt) => (id === "h2" ? { id, spoken: DIGITS, labels_added: [] } : compliant(id, prompt));
  const rowsFor = (s: ScriptV1) => runL0(s, undefined).filter((r) => r.check_id === "Q-V9");

  it("counts the spelled words, so the plain cap rejects a line that fits only in digits", async () => {
    expect(DIGITS.split(/\s+/)).toHaveLength(SPELLED_WORDS - 3);

    const result = await rewriteScript(cuedChoppy(), { harness: fakeRewriter(rewriteH2).harness, judge: sonnet, rounds: 1, speechClean: () => false });

    const rejected = result.report.rounds[0]!.rejected.find((r) => r.beat === "h2");
    expect(rejected?.rejections.map((r) => r.rule)).toContain("sentence-cap");
    expect(spokenOf(result.script, "h2")).not.toBe(DIGITS);
    expect(rowsFor(result.script).filter((r) => !r.pass)).toEqual(rowsFor(cuedChoppy()).filter((r) => !r.pass));
  });

  it("measures the before rows on spelled text", async () => {
    const digits = cuedChoppy();
    const result = await rewrite(digits, fakeRewriter(), { rounds: 1 });

    expect(hasSpokenDigits(result.script.beats[1]!.spoken)).toBe(false);
    expect(result.report.before).toEqual(targets(spellAll(digits)).map(({ check_id, value, threshold, pass }) => ({ check_id, value, threshold, pass })));
  });

  it("sends round 1 the spelled input, not its digits", async () => {
    const fake = fakeRewriter();

    await rewrite(cuedChoppy(), fake, { rounds: 1 });

    const prompt = fake.prompts.find((p) => p.includes("# Chapter ch1"))!;
    expect(prompt).toContain("The desk held twelve parcels today.");
    expect(prompt).not.toContain("The desk held 12 parcels today.");
  });

  it("leaves a spelled beat as it is when spelled again", () => {
    const beat = cuedChoppy().beats[1]!;
    const once = spellSpokenNumbers(beat);

    expect(spellSpokenNumbers(once)).toEqual(once);
  });
});

describe("spelling a script of ids", () => {
  const ids = "The desk closed PR 2324 after TP-4103 and then it also opened PR 2325 for the courier.";
  const idScript = (): ScriptV1 => {
    const plain = cuedChoppy();
    return { ...plain, beats: plain.beats.map((beat) => (beat.id === "h1" ? { ...beat, spoken: ids, visual: { ...beat.visual, cues: [] } } : beat)) };
  };
  const failing = (s: ScriptV1): string[] => runL0(s).filter((row) => !row.pass).map((row) => row.check_id);

  it("adds no failing row (Q-V9, Q-F11) when the digits are spelled", () => {
    const draft = idScript();

    expect(failing(spellAll(draft)).filter((id) => !failing(draft).includes(id))).toEqual([]);
  });
});
