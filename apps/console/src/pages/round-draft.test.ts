// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { clearDraft, draftKey, emptyDraft, loadDraft, saveDraft, type DraftAnswers } from "./round-draft.js";

afterEach(() => localStorage.clear());

const SHA = "1".repeat(64);
const ROUND = "glaze-picker-r1";

const draft: DraftAnswers = {
  answers: { finish: { pick: "Satin" }, swatches: { picks: ["Celadon", "Tenmoku"] }, legibility: { value: 3 }, notes: { text: "More contrast." } },
  comments: { finish: "Satin reads warmer." },
  optionNotes: { swatches: { Celadon: "Too pale at small sizes." } },
  general: "Close to done.",
  frames: {
    "swatch-grid": {
      verdict: "rejected",
      comment: "Grid gaps are uneven.",
      pins: [{ id: "swatch-grid-2", width: 1280, x: 640, y: 120, xPct: 0.5, yPct: 0.25, note: "This gap", target: { testId: "swatch-row" } }],
      pinsIssued: 2,
    },
  },
};

describe("a stored round draft", () => {
  it("round-trips answers, option notes, comments, frame verdicts and pins for the same manifest sha", () => {
    saveDraft(localStorage, ROUND, SHA, draft);

    expect(loadDraft(localStorage, ROUND, SHA)).toEqual({ draft, discarded: false });
  });

  it("is discarded and removed when the manifest sha differs", () => {
    saveDraft(localStorage, ROUND, SHA, draft);

    expect(loadDraft(localStorage, ROUND, "2".repeat(64))).toEqual({ discarded: true });
    expect(localStorage.getItem(draftKey(ROUND))).toBeNull();
  });

  it("belongs to one round id only", () => {
    saveDraft(localStorage, ROUND, SHA, draft);

    expect(loadDraft(localStorage, "glaze-picker-r2", SHA)).toEqual({ discarded: false });
  });

  it.each([
    ["corrupt JSON", "{\"manifestSha256\":"],
    ["a pin outside its frame", JSON.stringify({ manifestSha256: SHA, draft: { ...draft, frames: { a: { ...draft.frames["swatch-grid"], pins: [{ ...draft.frames["swatch-grid"].pins[0], xPct: 4 }] } } } })],
    ["an unknown verdict", JSON.stringify({ manifestSha256: SHA, draft: { ...draft, frames: { a: { ...draft.frames["swatch-grid"], verdict: "love" } } } })],
    ["a bare string", JSON.stringify("draft")],
  ])("ignores %s without throwing", (_, raw) => {
    localStorage.setItem(draftKey(ROUND), raw);

    expect(loadDraft(localStorage, ROUND, SHA)).toEqual({ discarded: false });
  });

  it("keeps no draft when storage throws", () => {
    const failing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("denied"); } } as unknown as Storage;

    expect(() => saveDraft(failing, ROUND, SHA, draft)).not.toThrow();
    expect(() => clearDraft(failing, ROUND)).not.toThrow();
    expect(loadDraft(failing, ROUND, SHA)).toEqual({ discarded: false });
  });

  it("counts blank comments and cleared verdicts as nothing typed", () => {
    const blank: DraftAnswers = { answers: {}, comments: { finish: "  " }, optionNotes: { swatches: { Celadon: "" } }, general: " ", frames: { a: { verdict: null, comment: "", pins: [], pinsIssued: 1 } } };

    expect(emptyDraft(blank)).toBe(true);
    expect(emptyDraft({ ...blank, general: "Ship it." })).toBe(false);
  });
});
