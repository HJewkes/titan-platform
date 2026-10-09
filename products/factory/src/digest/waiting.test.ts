import { describe, expect, it } from "vitest";
import { fakeSources, NOW, SLOT, watchRow } from "../test-support/digest.js";
import { collectDigest } from "./collect.js";
import { rankDigest } from "./rank.js";
import { renderMarkdown } from "./render-md.js";

const gateRow = (n: number, stepId: string, hoursAgo: number) =>
  watchRow({ pr: n, runId: `run-${n}`, pendingGate: { gateId: `run-${n}/${stepId}`, stepId, since: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() } });

async function collect(rows: ReturnType<typeof gateRow>[]) {
  return collectDigest({ sources: fakeSources({ rows: async () => rows }), now: NOW, windowMinutes: 360, slot: SLOT });
}

describe("owner-waiting gates in the digest", () => {
  it("takes the five oldest owner gates, oldest first, and leaves seat work out", async () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => gateRow(n, "approve-merge", n * 2)).concat(gateRow(8, "ci-failed", 100));

    const model = await collect(rows);

    expect(model.waiting?.map((g) => g.pr)).toEqual([7, 6, 5, 4, 3]);
  });

  it("renders a section with each gate's age, and omits it when nothing waits on the owner", async () => {
    const withGate = renderMarkdown(rankDigest(await collect([gateRow(3, "approve-merge", 30)])));
    const without = renderMarkdown(rankDigest(await collect([gateRow(8, "ci-failed", 30)])));

    expect(withGate).toContain("Waiting on you, oldest first");
    expect(withGate).toContain("30h run-3/approve-merge acme/widgets#3");
    expect(without).not.toContain("Waiting on you");
  });
});
