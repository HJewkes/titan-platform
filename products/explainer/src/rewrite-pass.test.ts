import { describe, expect, it } from "vitest";
import type { JudgeHarness } from "./eval-harness.js";
import { runL0, type L0Result } from "./eval-l0.js";
import { registerCheck } from "./lint-register.js";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { bandDistance, rewriteScript, roundRefusal } from "./rewrite-pass.js";
import { REWRITE_TARGET_ROWS } from "./rewrite-plan.js";
import { hasSpokenDigits, spellSpokenNumbers } from "./spoken-numbers.js";
import type { ScriptV1 } from "./script-schema.js";
import { BEATS, choppy, compliant, fakeRewriter, promptBeatIds, REWRITES, type Rewriter } from "./rewrite-fixtures.test-helpers.js";

const isRoundTwo = (prompt: string): boolean => prompt.includes("Change only what the lines above name");

const rewrite = (script: ScriptV1, fake = fakeRewriter(), options: { rounds?: number } = {}) =>
  rewriteScript(script, { harness: fake.harness, judge: sonnet, ...options });

const targets = (s: ScriptV1) => runL0(s, undefined, [registerCheck]).filter((row) => (REWRITE_TARGET_ROWS as readonly string[]).includes(row.check_id));
const failingTargets = (s: ScriptV1): string[] => targets(s).filter((row) => !row.pass).map((row) => row.check_id);
const spokenOf = (s: ScriptV1, id: string): string => s.beats.find((beat) => beat.id === id)!.spoken;
const spellAll = (s: ScriptV1): ScriptV1 => ({ ...s, beats: s.beats.map(spellSpokenNumbers) });
const labelsOf = (s: ScriptV1, id: string): string[] => s.beats.find((beat) => beat.id === id)!.visual.labels;

describe("rewriteScript with compliant rewrites", () => {
  it("brings all five target rows into band and moves the extra numbers to labels", async () => {
    const script = choppy();

    const { script: out, report } = await rewrite(script);

    expect(failingTargets(script).sort()).toEqual([...REWRITE_TARGET_ROWS].sort());
    expect(failingTargets(out)).toEqual([]);
    expect(report.rounds[0]).toMatchObject({ kept: true, rejected: [], reverted: [] });
    expect(report.after.every((row) => row.pass)).toBe(true);
    expect(report.before.filter((row) => !row.pass)).toHaveLength(5);
    expect(labelsOf(out, "h2")).toEqual(["3 sent back"]);
    expect(labelsOf(out, "c3")).toEqual(["2 ghost labels caught"]);
  });

  it("keeps every beat's fact ids and spells the numbers it still speaks", async () => {
    const script = choppy();

    const { script: out } = await rewrite(script);

    expect(out.beats.map((beat) => beat.fact_ids)).toEqual(script.beats.map((beat) => beat.fact_ids));
    expect(out.beats.filter((beat) => hasSpokenDigits(beat.spoken))).toEqual([]);
    expect(spokenOf(out, "h2")).toContain("twelve parcels");
  });

  it("stops after the round that brings every target row into band, and sums the spend of each call", async () => {
    const fake = fakeRewriter();

    const { report } = await rewrite(choppy(), fake);

    expect(report.rounds.map((round) => round.round)).toEqual([1]);
    expect(report.calls.map((call) => call.chapter)).toEqual(["ch1", "ch2", "ch3", "ch4"]);
    expect(report.usd).toBeCloseTo(0.04);
    expect(report.tokensIn).toBe(1600);
    expect(report.tokensOut).toBe(480);
    expect(report.judge).toBe("claude-print:sonnet");
  });

  it("makes no call for a script whose target rows already pass", async () => {
    const fake = fakeRewriter();
    const { script: done } = await rewrite(choppy(), fake);
    const again = fakeRewriter();

    const { report } = await rewrite(done, again);

    expect(again.prompts).toEqual([]);
    expect(report.rounds).toEqual([]);
  });
});

describe("rewriteScript guard and revert", () => {
  it("moves a cue on a number it carries to a label onto that label's noun in the line", async () => {
    const cue = { visual: { assertion: "The ledger holds rows per dock", job: "map", cues: [{ action: "V6", target: "n1", atCue: "50" }] } };

    const { script: out, report } = await rewrite(choppy({ w4: cue }), fakeRewriter(), { rounds: 1 });

    expect(report.rounds[0]!.rewritten).toContain("w4");
    expect(out.beats.find((beat) => beat.id === "w4")!.visual.cues.map((c) => c.atCue)).toEqual(["rows"]);
  });

  it("keeps a beat whose rewrite drops a cue word, and reports why", async () => {
    const cue = { visual: { assertion: "The ledger names a dock", job: "map", cues: [{ action: "V6", target: "n1", atCue: "dock" }] } };
    const script = choppy({ w2: cue });
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

    const { script: out, report } = await rewrite(choppy(), fakeRewriter(addsBannedWord), { rounds: 1 });

    expect(report.rounds[0]!.reverted).toEqual([{ beat: "k3", rows: ["Q-V7"] }]);
    expect(spokenOf(out, "k3")).toBe(BEATS.k3![1].before);
    expect(report.rounds[0]!.kept).toBe(true);
    expect(spokenOf(out, "k2")).toContain("at the counter");
  });

  it("reports a skipped beat as missing and leaves it as written", async () => {
    const skipsH1: Rewriter = (id, prompt) => (id === "h1" ? undefined : compliant(id, prompt));

    const { script: out, report } = await rewrite(choppy(), fakeRewriter(skipsH1), { rounds: 1 });

    expect(spokenOf(out, "h1")).toBe(BEATS.h1![1].before);
    expect(report.rounds[0]!.rejected).toEqual([{ beat: "h1", rejections: [expect.objectContaining({ rule: "missing" })] }]);
    expect(report.rounds[0]!.rejected[0]).not.toHaveProperty("candidate");
  });
});

describe("rewriteScript fails closed", () => {
  it("leaves a failed call's chapter unchanged, reports it, and does not retry it", async () => {
    const fake = fakeRewriter(compliant, (prompt) => (prompt.includes("# Chapter ch2") ? "budget_exceeded: over cap" : undefined));

    const { script: out, report } = await rewrite(choppy(), fake, { rounds: 1 });

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

    const { script: out, report } = await rewriteScript(choppy(), { harness, judge: sonnet, rounds: 1 });

    expect(report.calls.every((call) => !call.ok && call.reason === "claude exited 1")).toBe(true);
    expect(out.beats.map((beat) => beat.visual.labels)).toEqual(out.beats.map(() => []));
    expect(spokenOf(out, "h1")).toBe(BEATS.h1![1].before);
  });
});

describe("rewriteScript rounds", () => {
  it("discards a round that moves the script further from band, keeping the text before it", async () => {
    const clipped: Rewriter = (id) => ({ id, spoken: REWRITES.get(id)!.before.replace(/ the /g, " "), labels_added: [] });

    const { script: out, report } = await rewrite(choppy(), fakeRewriter(clipped));

    expect(report.rounds.map((round) => [round.round, round.kept])).toEqual([[1, false], [2, false]]);
    expect(report.rounds[0]!.why).toBe("the distance to band did not fall");
    expect(spokenOf(out, "h1")).toBe(BEATS.h1![1].before);
  });

  it("runs round 2 on round 1's text, only for beats still holding a triad or crowded numbers", async () => {
    const leavesTriad: Rewriter = (id, prompt) => {
      if (id === "c2" && !isRoundTwo(prompt)) return { id, spoken: BEATS.c2![1].before.replace("That order matters.", "That order matters a lot."), labels_added: [] };
      return compliant(id, prompt);
    };
    const fake = fakeRewriter(leavesTriad);

    const { script: out, report } = await rewrite(choppy(), fake);

    const roundTwo = fake.prompts.filter(isRoundTwo);
    expect(report.rounds.map((round) => round.kept)).toEqual([true, true]);
    expect(roundTwo.map(promptBeatIds)).toEqual([["c2"]]);
    expect(roundTwo[0]).toContain("That order matters a lot.");
    expect(spokenOf(out, "c2")).toBe(BEATS.c2![1].after);
    expect(failingTargets(out)).toEqual([]);
  });

  it("stops after the rounds it is given", async () => {
    const fake = fakeRewriter(() => undefined);

    const { report } = await rewrite(choppy(), fake, { rounds: 1 });

    expect(report.rounds.map((round) => round.round)).toEqual([1]);
  });

  it("refuses a round count outside 1..2", async () => {
    await expect(rewrite(choppy(), fakeRewriter(), { rounds: 3 })).rejects.toThrow(RangeError);
    await expect(rewrite(choppy(), fakeRewriter(), { rounds: 0 })).rejects.toThrow(RangeError);
  });
});

describe("rewriteScript with a speech verdict", () => {
  const LONG = "The desk refuses ghost labels. When a courier at the front counter asks for a label, the desk looks for the parcel row in the ledger and waits for that answer before it prints.";

  it("keeps a vetted long sentence that the plain cap would refuse", async () => {
    const longH1: Rewriter = (id, prompt) => (id === "h1" ? { id, spoken: LONG, labels_added: [] } : compliant(id, prompt));

    const plain = await rewrite(choppy(), fakeRewriter(longH1), { rounds: 1 });
    const vetted = await rewriteScript(choppy(), { harness: fakeRewriter(longH1).harness, judge: sonnet, rounds: 1, speechClean: () => true });

    expect(plain.report.rounds[0]!.rejected.map((r) => r.beat)).toEqual(["h1"]);
    expect(spokenOf(vetted.script, "h1")).toBe(LONG);
    expect(vetted.report.rounds[0]!.reverted).toEqual([]);
  });
});

const row = (check_id: string, value: number, threshold: number, pass: boolean, severity: "error" | "warning" = "warning"): L0Result => ({
  check_id, mode: "heuristic", severity, value, threshold, pass, detail_beats: [],
});

describe("roundRefusal", () => {
  const before = [row("register:sentence-mean", 6, 12.51, false), row("register:numbers", 18, 25.62, true), row("Q-V7", 0, 0, true, "error")];

  it("keeps a round that comes closer to band without failing more rows", () => {
    const after = [row("register:sentence-mean", 10, 12.51, false), row("register:numbers", 18, 25.62, true), row("Q-V7", 0, 0, true, "error")];
    expect(roundRefusal(before, after)).toBeUndefined();
  });

  it("refuses a round that fails more target rows, even when the distance falls", () => {
    const after = [row("register:sentence-mean", 12, 12.51, false), row("register:numbers", 26, 25.62, false), row("Q-V7", 0, 0, true, "error")];
    expect(bandDistance(after)).toBeLessThan(bandDistance(before));
    expect(roundRefusal(before, after)).toBe("more target rows fail");
  });

  it("refuses a round whose distance to band does not fall", () => {
    expect(roundRefusal(before, before)).toBe("the distance to band did not fall");
  });

  it("refuses a round that fails more error rows", () => {
    const after = [row("register:sentence-mean", 10, 12.51, false), row("register:numbers", 18, 25.62, true), row("Q-V7", 1, 0, false, "error")];
    expect(roundRefusal(before, after)).toBe("more error rows fail");
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

    const result = await rewriteScript(choppy(), { harness: fakeRewriter(rewriteH2).harness, judge: sonnet, rounds: 1, speechClean: () => false });

    const rejected = result.report.rounds[0]!.rejected.find((r) => r.beat === "h2");
    expect(rejected?.rejections.map((r) => r.rule)).toContain("sentence-cap");
    expect(spokenOf(result.script, "h2")).not.toBe(DIGITS);
    expect(rowsFor(result.script).filter((r) => !r.pass)).toEqual(rowsFor(choppy()).filter((r) => !r.pass));
  });

  it("measures the before rows on spelled text", async () => {
    const digits = choppy();
    const result = await rewrite(digits, fakeRewriter(), { rounds: 1 });

    expect(hasSpokenDigits(result.script.beats[1]!.spoken)).toBe(false);
    expect(result.report.before).toEqual(targets(spellAll(digits)).map(({ check_id, value, threshold, pass }) => ({ check_id, value, threshold, pass })));
  });

  it("sends round 1 the spelled input, not its digits", async () => {
    const fake = fakeRewriter();

    await rewrite(choppy(), fake, { rounds: 1 });

    const prompt = fake.prompts.find((p) => p.includes("# Chapter ch1"))!;
    expect(prompt).toContain("twelve parcels");
    expect(prompt).not.toContain("12 parcels");
  });

  it("leaves a spelled beat as it is when spelled again", () => {
    const beat = choppy().beats[1]!;
    const once = spellSpokenNumbers(beat);

    expect(spellSpokenNumbers(once)).toEqual(once);
  });
});
