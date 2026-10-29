import { describe, expect, it } from "vitest";
import { registeredKinds, resolveBeat } from "./composition/registry.js";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { repairHint } from "./l0-repair-hints.js";
import { HEADLINE_FREE_KINDS } from "./drawn-beats.js";

const SENTENCES = ["router · The router lane wants every match to finish faster", "cache · The cache lane wants its store warm before the rush", "label · Fewer reprints"];
const KEY_WORDS = ["router · Faster matches", "cache · Warm store", "label · Fewer reprints"];

describe("Q-D15 words on screen, as qa counts them", () => {
  it("a beat over 20 on-screen words fails", () => {
    const script = dailyWith("goals-1", { visual: { labels: SENTENCES } });

    const row = l0Row(script, "Q-D15");
    const hint = repairHint(row, script);

    expect(row).toMatchObject({ severity: "error", pass: false });
    expect(row.detail_beats).toContain("goals-1");
    expect(hint).toContain("goals-1 (35 words as list)");
    expect(hint).toContain("key words");
  });

  it("passes once the rows are key words, the lane chips left out as qa leaves them out", () => {
    const script = dailyWith("goals-1", { visual: { labels: KEY_WORDS } });

    const row = l0Row(script, "Q-D15");

    expect(row.detail_beats).not.toContain("goals-1");
  });

  it("counts a fourth row without the chapter heading that gives way to it", () => {
    const script = dailyWith("goals-1", { visual: { labels: [...KEY_WORDS, "dock · Shorter queues"] } });

    const row = l0Row(script, "Q-D15");

    expect(row.detail_beats).not.toContain("goals-1");
  });

  it("counts a claim card's claim and source line, not the headline its page hides", () => {
    const assertion = "Small lanes ship faster than one big queue because no lane waits on the others to land";
    const script = dailyWith("reflection-2", { visual: { assertion, chips: [{ kind: "computed", text: "floor queue this week" }] } });

    const row = l0Row(script, "Q-D15");

    expect(row.detail_beats).not.toContain("reflection-2");
  });

  it("leaves out a beat on a custom layer, whose text the layer draws as it chooses", () => {
    const script = dailyWith("lanes-1", { visual: { beat: "kanban-flow", layer: "custom", labels: SENTENCES } });

    const row = l0Row(script, "Q-D15");

    expect(row.detail_beats).not.toContain("lanes-1");
  });

  it("knows the page's headline-free kinds: no chrome headline, or a page that owns the canvas", () => {
    const shown = registeredKinds().filter((kind) => kind !== "catalogue");

    const free = shown.filter((kind) => !resolveBeat(kind).headline || !resolveBeat(kind).stage);

    expect(free.sort()).toEqual([...HEADLINE_FREE_KINDS].sort());
  });
});
