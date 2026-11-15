import { describe, expect, it } from "vitest";
import { deriveEvalView } from "./eval-view.js";
import { repairHint } from "./l0-repair-hints.js";
import { goodScript } from "./lint-fixtures.test-helpers.js";
import { whyCheck } from "./lint-why.js";

describe("the promise repair hint", () => {
  it("asks for the question the video settles, in you terms, and never for you'll know", () => {
    const good = goodScript();
    const script = { ...good, video: { ...good.video, promise: "By the end you’ll spot a bad label." } };
    const row = whyCheck({ script, view: deriveEvalView(script) }).find((r) => r.check_id === "Q-W5")!;

    const hint = repairHint(row, script) ?? "";

    expect(hint).toContain("question");
    expect(hint).toContain('"By the end"');
    expect(hint).not.toContain("you'll know");
  });

  it("offers an example promise that passes Q-W5 itself", () => {
    const good = goodScript();
    const bad = { ...good, video: { ...good.video, promise: "By the end you’ll spot a bad label." } };
    const row = whyCheck({ script: bad, view: deriveEvalView(bad) }).find((r) => r.check_id === "Q-W5")!;
    const example = /for example "([^"]+)"/.exec(repairHint(row, bad) ?? "")?.[1] ?? "";

    const script = { ...good, video: { ...good.video, promise: example } };

    expect(example).not.toBe("");
    expect(whyCheck({ script, view: deriveEvalView(script) }).find((r) => r.check_id === "Q-W5")?.pass).toBe(true);
  });
});
