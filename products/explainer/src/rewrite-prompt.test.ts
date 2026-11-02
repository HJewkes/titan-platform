import { describe, expect, it } from "vitest";
import { loadDoctrine } from "./doctrine-load.js";
import { findPromptLeaks } from "./doctrine-slice.js";
import { REGISTER_BANDS } from "./lint-register.js";
import { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS } from "./lint-voice.js";
import type { RefusalRule, RegisterEditPlan } from "./rewrite-plan.js";
import { refusalNote, renderRewritePrompt } from "./rewrite-prompt.js";
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
  "empty", "entity", "markup", "terms", "length", "number-lost", "number-invented", "range-split", "number-vague", "device-added",
  "closer-added", "list-lost", "list-emptied", "cue-lost", "cue-order", "new-term", "fact-id", "sentence-cap", "missing",
];
const refusedPlan = (refused: RefusalRule[]): RegisterEditPlan => ({
  round: 2,
  directives: [{ beat: "w2", chapter: "ch2", triads: ["the scan, the row and the label."], refused }],
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

  it("directs against new lists of three and numbers moved to labels", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, plan(1));

    expect(prompt).toMatch(/do not build a new list of three/);
    expect(prompt).toMatch(/Never put a number in `labels_added`/);
    expect(prompt).toContain('- Numbers: this beat speaks "12", "two". Keep the one its claim turns on and cut the others with the clause they count; put none of them in labels_added.');
  });

  it("tells a triad beat to label every item without singling one out", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, plan(1));

    expect(prompt).toContain('- Lists of three: "the scan, the row and the label.". Put every item in labels_added, one each');
    expect(prompt).not.toMatch(/the one that matters/i);
  });

  it("names the cue word a collapsing list holds as the item that stays in the line", () => {
    const cuedList: RegisterEditPlan = { round: 1, directives: [{ beat: "w2", chapter: "ch2", triads: ["the desk, the row and the label."] }] };

    const prompt = renderRewritePrompt(chapter, chapterBeats, cuedList);

    expect(prompt).toContain('- The screen cues on "desk": the list item that holds each one is the item you keep in the line.');
    expect(renderRewritePrompt(chapter, chapterBeats, plan(1))).not.toContain("- The screen cues on");
  });

  it("asks a beat to say its stock phrases in plain words, naming each", () => {
    const withPhrases: RegisterEditPlan = { round: 1, directives: [{ beat: "w2", chapter: "ch2", shape: [5, 18], phrases: ["stays", "the catch"] }] };

    const prompt = renderRewritePrompt(chapter, chapterBeats, withPhrases);

    expect(prompt).toContain('- Stock phrases: "stays", "the catch". Say what each one means in plain words of your own.');
    expect(renderRewritePrompt(chapter, chapterBeats, plan(1))).not.toContain("- Stock phrases:");
  });

  it("tells a refused beat in plain words why its last version was not used", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, refusedPlan(["sentence-cap", "list-emptied", "number-lost"]));

    expect(notesIn(prompt)).toEqual([
      "- Your last version was not used: a sentence was too long to say in one breath; split it.",
      "- Your last version was not used: keep one item of the list in the line.",
      "- Your last version was not used: a number the screen shows left the line; keep saying it, and put no number in a label.",
    ]);
  });

  it("has its own note for every refusal rule and a plain fallback for one it does not know", () => {
    const notes = EVERY_REFUSAL.map(refusalNote);

    expect(refusalNote("some-new-rule")).toBe("it changed what the beat says; stay closer to the original");
    expect(new Set([...notes, refusalNote("some-new-rule")]).size).toBe(EVERY_REFUSAL.length + 1);
    expect(notesIn(renderRewritePrompt(chapter, chapterBeats, refusedPlan(EVERY_REFUSAL)))).toHaveLength(EVERY_REFUSAL.length);
  });

  it("names no rule id, code-enforced rule or band number in any refusal note", () => {
    const prompt = renderRewritePrompt(chapter, chapterBeats, refusedPlan(EVERY_REFUSAL));
    const notes = notesIn(prompt).join("\n");

    expect(findPromptLeaks(prompt, loadDoctrine(), loadRuleRegistry())).toEqual([]);
    noLimitIn(prompt);
    expect([notes, refusalNote("some-new-rule")].join("\n")).not.toMatch(/\d/);
    for (const rule of EVERY_REFUSAL.filter((r) => r.includes("-"))) expect(prompt).not.toContain(rule);
  });

  it("gives a beat with no refusal no note", () => {
    expect(notesIn(renderRewritePrompt(chapter, chapterBeats, plan(2)))).toEqual([]);
  });
});
