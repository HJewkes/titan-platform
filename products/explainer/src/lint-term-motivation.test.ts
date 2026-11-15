import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";

const CHECK_ID = "hallmark:motivated-before-named";

// In the daily script the "lanes" chapter starts at 32 s of plan, and no earlier beat says "rewrote" or "eviction".
// "lanes-1" speaks "rewrote" as its fourth of 19 words: about 3 s into the chapter but about 35 s into the script, so
// only a chapter-relative clock counts it. "lanes-2" speaks "eviction" as its 13th of 17 words, 18 s + about 13 s
// into the chapter.
const declare = (beat: string, terms: string[]) => dailyWith(beat, { new_terms: terms });

describe("hallmark:motivated-before-named counts terms named before their chapter has motivated them", () => {
  it("counts a term named in its chapter's first sentence", () => {
    const script = declare("lanes-1", ["rewrote"]);

    const row = l0Row(script, CHECK_ID);

    expect(row.value).toBe(1);
  });

  it("does not count a term first said after 25 s of build-up", () => {
    const script = declare("lanes-2", ["eviction"]);

    const row = l0Row(script, CHECK_ID);

    expect(row.value).toBe(0);
  });

  it("ignores a word the script never declares", () => {
    const script = dailyWith("lanes-1", { new_terms: [] });

    const row = l0Row(script, CHECK_ID);

    expect(row.value).toBe(0);
  });

  it("passes as report-only with the count as its value", () => {
    const script = declare("lanes-1", ["rewrote"]);

    const row = l0Row(script, CHECK_ID);

    expect(row).toMatchObject({ severity: "warning", pass: true, value: 1, threshold: 0 });
  });
});
