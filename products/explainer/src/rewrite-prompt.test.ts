import { describe, expect, it } from "vitest";
import { loadDoctrine } from "./doctrine-load.js";
import { findPromptLeaks } from "./doctrine-slice.js";
import { REGISTER_BANDS } from "./lint-register.js";
import { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS } from "./lint-voice.js";
import type { RefusalRule, RegisterEditPlan } from "./rewrite-plan.js";
import { renderRewritePrompt } from "./rewrite-prompt.js";
import { loadRuleRegistry } from "./rules.js";
import { tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";

const cues = [
  { action: "V6", target: "ledger-row", atCue: "ledger" },
  { action: "V6", target: "desk-card", atCue: "desk#2" },
];
const script = tour(
  withBeat("w2", {
    spoken: "The desk holds each scan while the ledger looks, and the desk prints only after it hears back.",
    extra: { new_terms: ["ledger"], visual: { assertion: "The desk waits", job: "numbers", cues } },
  }),
);
const chapter = script.chapters.find((c) => c.id === "ch2")!;
const chapterBeats = script.beats.filter((beat) => beat.chapter === "ch2");

const plan = (round: 1 | 2): RegisterEditPlan => ({
  round,
  directives: [{ beat: "w2", chapter: "ch2", numbers: ["12", "two"], triads: ["the scan, the row and the label."], shape: [5, 18] }],
});

const EVERY_REFUSAL: RefusalRule[] = [
  "empty", "entity", "markup", "terms", "length", "number-lost", "number-invented", "number-vague", "device-added",
  "label-bare", "list-lost", "list-emptied", "cue-lost", "cue-order", "new-term", "sentence-cap", "missing",
];
const refusedPlan = (refused: string[]): RegisterEditPlan => ({
  round: 2,
  directives: [{ beat: "w2", chapter: "ch2", triads: ["the scan, the row and the label."], refused: refused as RefusalRule[] }],
});
const notesIn = (prompt: string): string[] => prompt.split("\n").filter((line) => line.startsWith("- Your last version was not used: "));
const LIMITS = [MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS, ...Object.values(REGISTER_BANDS).flatMap((b) => [b.min, b.max])].filter((n) => n !== undefined);
const noLimitIn = (prompt: string): void => {
  for (const limit of LIMITS) expect(prompt).not.toMatch(new RegExp(`(?<![\\d.])${String(limit).replace(".", "\\.")}(?![\\d])`));
};

describe("renderRewritePrompt", () => {
  it("names no code-enforced rule", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, plan(1));

    expect(findPromptLeaks(prompt, loadDoctrine(), loadRuleRegistry())).toEqual([]);
  });

  it("carries no band value or sentence cap, only the beat's own counts", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, plan(1));

    noLimitIn(prompt);
    expect(prompt).toContain("- Shape: 2 sentences of about 5 and 18 words, in any order.");
  });

  it("lists only the directed beats, with cue words in spoken order and without their occurrence suffix", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, plan(1));

    expect(prompt).toContain("## w2\nOriginal: The desk holds each scan");
    expect(prompt).toContain("Cue words, in order: ledger, desk\nTerms to keep: ledger");
    expect(prompt).not.toContain("## w1");
    expect(prompt).toContain('- Numbers: this beat speaks "12", "two".');
  });

  it("tells a round-2 beat to change only what its directive names", () => {
    const only = "Change only what the lines above name";

    expect(renderRewritePrompt(chapter, chapterBeats, plan(2))).toContain(only);
    expect(renderRewritePrompt(chapter, chapterBeats, plan(1))).not.toContain(only);
  });

  it("directs against new lists of three and bare-number labels", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, plan(1));

    expect(prompt).toMatch(/do not build a new list of three/);
    expect(prompt).toMatch(/with the noun it counts/);
  });

  it("tells a triad beat to label every item without singling one out", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, plan(1));

    expect(prompt).toContain('- Lists of three: "the scan, the row and the label.". Put every item in labels_added, one each');
    expect(prompt).not.toMatch(/the one that matters/i);
  });

  it("tells a refused beat in plain words why its last version was not used", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, refusedPlan(["sentence-cap", "list-emptied", "number-lost"]));

    expect(notesIn(prompt)).toEqual([
      "- Your last version was not used: a sentence was too long to say in one breath; split it.",
      "- Your last version was not used: keep one item of the list in the line.",
      "- Your last version was not used: the number left the line without its noun in a label; label it with the noun it counts.",
    ]);
  });

  it("has its own note for every refusal rule and a plain fallback for one it does not know", () => {
    const fallback = notesIn(renderRewritePrompt(chapter, chapterBeats, refusedPlan(["some-new-rule"])));
    const notes = EVERY_REFUSAL.map((rule) => notesIn(renderRewritePrompt(chapter, chapterBeats, refusedPlan([rule])))[0]);

    expect(fallback).toEqual(["- Your last version was not used: it changed what the beat says; stay closer to the original."]);
    expect(new Set([...notes, fallback[0]]).size).toBe(EVERY_REFUSAL.length + 1);
  });

  it("names no rule id, code-enforced rule or band number in any refusal note", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, refusedPlan([...EVERY_REFUSAL, "some-new-rule"]));
    const notes = notesIn(prompt).join("\n");

    expect(findPromptLeaks(prompt, loadDoctrine(), loadRuleRegistry())).toEqual([]);
    noLimitIn(prompt);
    expect(notes).not.toMatch(/\d/);
    for (const rule of EVERY_REFUSAL.filter((r) => r.includes("-"))) expect(prompt).not.toContain(rule);
  });

  it("gives a beat with no refusal no note", () => {
    expect(notesIn(renderRewritePrompt(chapter, chapterBeats, plan(2)))).toEqual([]);
  });
});
