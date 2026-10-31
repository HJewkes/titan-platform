import { describe, expect, it } from "vitest";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { overlongSentence } from "./lint-voice.js";
import { compliant, cuedChoppy, fakeRewriter, type Rewriter } from "./rewrite-fixtures.test-helpers.js";
import { rewriteScript } from "./rewrite-pass.js";
import { splitOverlong } from "./rewrite-split.js";

const plainCap = (sentence: string): boolean => overlongSentence(sentence, undefined);

describe("splitOverlong", () => {
  it("splits a new 28-word sentence at its most even comma joint", () => {
    const spoken = "The ledger answers in nine milliseconds for every dock on the floor, and the desk trusts that answer because it never caches a single row it reads.";

    const out = splitOverlong("", spoken, plainCap);

    expect(out).toBe("The ledger answers in nine milliseconds for every dock on the floor. And the desk trusts that answer because it never caches a single row it reads.");
  });

  it("splits a 44-word sentence twice, so each piece is under the cap", () => {
    const spoken =
      "The desk reads the scan from the courier at the counter before noon each day, and the ledger keeps a row for every parcel that comes through the dock door, and the printer waits for both of them before it prints a single label.";

    const out = splitOverlong("", spoken, plainCap);

    expect(out).toBe(
      "The desk reads the scan from the courier at the counter before noon each day. And the ledger keeps a row for every parcel that comes through the dock door. And the printer waits for both of them before it prints a single label.",
    );
  });

  it("turns a which before a singular verb into That when that joint is the most even", () => {
    const spoken =
      "Rule on the first ticket on the screen, then take up the dock ticket, which carries the parcel reservations into the new loading queue, and whatever you pick for the first one should survive that move.";

    const out = splitOverlong("", spoken, plainCap);

    expect(out).toBe(
      "Rule on the first ticket on the screen, then take up the dock ticket. That carries the parcel reservations into the new loading queue, and whatever you pick for the first one should survive that move.",
    );
  });

  it("turns a causal joint into its own sentence that keeps the cause", () => {
    const spoken = "You could lose the loading queue, because the first ticket turned dock order on and the second ticket shows a red scan can stall it for hours.";

    const out = splitOverlong("", spoken, plainCap);

    expect(out).toBe("You could lose the loading queue. That's because the first ticket turned dock order on and the second ticket shows a red scan can stall it for hours.");
  });

  it("leaves a long sentence with no comma joint as it is, for the guard to refuse", () => {
    const spoken = "It checks the scan and the row before the label so that nothing is skipped and the courier never sees a guess and the check is always fast.";

    expect(splitOverlong("", spoken, plainCap)).toBe(spoken);
  });

  it("leaves a long sentence the original already said, and every sentence under the cap", () => {
    const long = "The ledger answers in nine milliseconds for every dock on the floor, and the desk trusts that answer because it never caches a single row it reads.";
    const spoken = `${long} The desk prints, and the courier leaves.`;

    expect(splitOverlong(long, spoken, plainCap)).toBe(spoken);
  });

  it("does not turn a which before a plural verb into That", () => {
    const spoken = "The desk sends the late parcels to the far dock at the end of the shift, which hold the labels that the morning courier needs to see.";

    expect(splitOverlong("", spoken, plainCap)).toBe(spoken);
  });
});

describe("rewriteScript on the workflow path, with no speech verdict", () => {
  // h1 joined into one 30-word sentence: past the plain cap, with one comma joint left over.
  const LONG_H1 =
    "When a courier asks for a label, the desk refuses ghost labels, so it looks for the parcel row and waits for the ledger before it prints anything at all.";
  const longH1: Rewriter = (id, prompt) => (id === "h1" ? { id, spoken: LONG_H1, labels_added: [] } : compliant(id, prompt));

  it("keeps a beat whose rewrite overshoots the cap, split at a clause joint, instead of refusing it", async () => {
    const script = cuedChoppy({ h1: { plannedS: 13 } });

    const { script: out, report } = await rewriteScript(script, { harness: fakeRewriter(longH1).harness, judge: sonnet, rounds: 1 });

    expect(report.rounds[0]!.rejected.flatMap((beat) => beat.rejections.map((r) => r.rule))).not.toContain("sentence-cap");
    expect(report.rounds[0]!.rewritten).toContain("h1");
    expect(out.beats.find((beat) => beat.id === "h1")!.spoken).toBe(
      "When a courier asks for a label, the desk refuses ghost labels. So it looks for the parcel row and waits for the ledger before it prints anything at all.",
    );
  });
});
