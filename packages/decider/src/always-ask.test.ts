import { describe, expect, it } from "vitest";
import { ALWAYS_ASK, alwaysAskList, isAlwaysAsk, type AlwaysAskEntry } from "./always-ask.js";

describe("ALWAYS_ASK", () => {
  it("holds the fixed categories no principle may answer", () => {
    expect(ALWAYS_ASK.map((e) => e.id)).toEqual([
      "visual_taste",
      "info_request",
      "external_action",
      "money",
      "personal_data",
      "third_party_message",
      "irreversible",
      "human_only",
    ]);
  });

  it("cannot be edited at runtime", () => {
    expect(() => (ALWAYS_ASK as AlwaysAskEntry[]).push({ id: "x", description: "x" })).toThrow();
    expect(() => {
      (ALWAYS_ASK[0] as { id: string }).id = "renamed";
    }).toThrow();
  });

  it("adds the charter's hard stops passed in, trimmed and deduplicated", () => {
    const list = alwaysAskList(["config edits", " config edits ", "", "force push"]);

    expect(list.slice(ALWAYS_ASK.length)).toEqual([
      { id: "hard_stop:config edits", description: "config edits" },
      { id: "hard_stop:force push", description: "force push" },
    ]);
    expect(isAlwaysAsk("hard_stop:force push", list)).toBe(true);
    expect(isAlwaysAsk("hard_stop:force push")).toBe(false);
  });

  it("answers membership for categories", () => {
    expect(isAlwaysAsk("money")).toBe(true);
    expect(isAlwaysAsk("tech_design")).toBe(false);
  });
});
