// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { clearDraft, draftKey, emptyDraft, loadDraft, saveDraft, type DraftAnswers } from "./round-draft.js";

afterEach(() => localStorage.clear());

const SHA = "1".repeat(64);
const ROUND = "glaze-picker-r1";

const PIN = { id: "swatch-grid-2", width: 1280, x: 640, y: 120, xPct: 0.5, yPct: 0.25, note: "This gap", target: { testId: "swatch-row" } };
const FRAME = { verdict: "rejected" as const, comment: "Grid gaps are uneven.", pins: [PIN], pinsIssued: 2 };

const draft: DraftAnswers = {
  answers: { finish: { pick: "Satin" }, swatches: { picks: ["Celadon", "Tenmoku"] }, legibility: { value: 3 }, notes: { text: "More contrast." } },
  comments: { finish: "Satin reads warmer." },
  optionNotes: { swatches: { Celadon: "Too pale at small sizes." } },
  general: "Close to done.",
  frames: { "swatch-grid": FRAME },
};

/** Storage as a private window or a full quota behaves: every call throws. */
class FailingStorage implements Storage {
  readonly length = 0;
  clear(): void {
    throw new Error("denied");
  }
  key(): string | null {
    throw new Error("denied");
  }
  getItem(): string | null {
    throw new Error("denied");
  }
  setItem(): void {
    throw new Error("quota exceeded");
  }
  removeItem(): void {
    throw new Error("denied");
  }
}

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
    ["a pin outside its frame", JSON.stringify({ manifestSha256: SHA, draft: { ...draft, frames: { a: { ...FRAME, pins: [{ ...PIN, xPct: 4 }] } } } })],
    ["an unknown verdict", JSON.stringify({ manifestSha256: SHA, draft: { ...draft, frames: { a: { ...FRAME, verdict: "love" } } } })],
    ["a bare string", JSON.stringify("draft")],
  ])("ignores %s without throwing", (_, raw) => {
    localStorage.setItem(draftKey(ROUND), raw);

    expect(loadDraft(localStorage, ROUND, SHA)).toEqual({ discarded: false });
  });

  it("keeps no draft when storage throws", () => {
    const failing = new FailingStorage();

    expect(() => saveDraft(failing, ROUND, SHA, draft)).not.toThrow();
    expect(() => clearDraft(failing, ROUND)).not.toThrow();
    expect(loadDraft(failing, ROUND, SHA)).toEqual({ discarded: false });
  });

  it("round-trips a Ship round's Addressed ticks, follow-ups, verdicts and Send back notes", () => {
    const ship = { addressed: [1], followUps: ["badge-colour"], verdicts: { "ship-tiles": "back" as const }, backNotes: { "ship-tiles": "Lift the stripe." } };
    saveDraft(localStorage, ROUND, SHA, { ...draft, ship });

    expect(loadDraft(localStorage, ROUND, SHA)).toEqual({ draft: { ...draft, ship }, discarded: false });
  });

  it("restores a draft saved before Ship rounds kept one, which has no ship part", () => {
    localStorage.setItem(draftKey(ROUND), JSON.stringify({ manifestSha256: SHA, draft }));

    expect(loadDraft(localStorage, ROUND, SHA)).toEqual({ draft, discarded: false });
  });

  it("ignores a Ship verdict that is neither Ship nor Send back", () => {
    const ship = { addressed: [], followUps: [], verdicts: { "ship-tiles": "maybe" }, backNotes: {} };
    localStorage.setItem(draftKey(ROUND), JSON.stringify({ manifestSha256: SHA, draft: { ...draft, ship } }));

    expect(loadDraft(localStorage, ROUND, SHA)).toEqual({ discarded: false });
  });

  it("counts blank comments and cleared verdicts as nothing typed", () => {
    const blank: DraftAnswers = { answers: {}, comments: { finish: "  " }, optionNotes: { swatches: { Celadon: "" } }, general: " ", frames: { a: { verdict: null, comment: "", pins: [], pinsIssued: 1 } } };

    expect(emptyDraft(blank)).toBe(true);
    expect(emptyDraft({ ...blank, general: "Ship it." })).toBe(false);
    expect(emptyDraft({ ...blank, ship: { addressed: [], followUps: [], verdicts: {}, backNotes: { "ship-tiles": " " } } })).toBe(true);
    expect(emptyDraft({ ...blank, ship: { addressed: [1], followUps: [], verdicts: {}, backNotes: {} } })).toBe(false);
    expect(emptyDraft({ ...blank, ship: { addressed: [], followUps: [], verdicts: { "ship-tiles": "ship" }, backNotes: {} } })).toBe(false);
  });
});
