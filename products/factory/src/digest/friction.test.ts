import { describe, expect, it } from "vitest";
import { emptyModel } from "../test-support/digest.js";
import { rankDigest } from "./rank.js";
import { renderMarkdown } from "./render-md.js";

describe("owner friction in the digest", () => {
  it("renders the owner touches line and the per-kind wait line", () => {
    const friction = { day: "2026-03-10", ownerTouches: 7, kinds: [{ kind: "approve-merge", gates: 3, medianHours: 4, maxHours: 10.5 }, { kind: "ci-failed", gates: 1, medianHours: 2, maxHours: 2 }] };

    const markdown = renderMarkdown(rankDigest(emptyModel({ friction })));

    expect(markdown).toContain("Owner touches 2026-03-10: 7");
    expect(markdown).toContain("Owner wait (median/max hours): approve-merge 4/10.5, ci-failed 2/2");
  });

  it("says so when no gate waited on the owner", () => {
    const markdown = renderMarkdown(rankDigest(emptyModel({ friction: { day: "2026-03-10", ownerTouches: 0, kinds: [] } })));

    expect(markdown).toContain("Owner touches 2026-03-10: 0");
    expect(markdown).toContain("Owner wait: none");
  });
});
