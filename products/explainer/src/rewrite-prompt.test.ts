import { describe, expect, it } from "vitest";
import { loadDoctrine } from "./doctrine-load.js";
import { findPromptLeaks } from "./doctrine-slice.js";
import { REGISTER_BANDS } from "./lint-register.js";
import { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS } from "./lint-voice.js";
import type { RegisterEditPlan } from "./rewrite-plan.js";
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

describe("renderRewritePrompt", () => {
  it("names no code-enforced rule", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, plan(1));

    expect(findPromptLeaks(prompt, loadDoctrine(), loadRuleRegistry())).toEqual([]);
  });

  it("carries no band value or sentence cap, only the beat's own counts", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, plan(1));
    const limits = [MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS, ...Object.values(REGISTER_BANDS).flatMap((b) => [b.min, b.max])];

    for (const limit of limits.filter((n) => n !== undefined)) expect(prompt).not.toMatch(new RegExp(`(?<![\\d.])${String(limit).replace(".", "\\.")}(?![\\d])`));
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
});
