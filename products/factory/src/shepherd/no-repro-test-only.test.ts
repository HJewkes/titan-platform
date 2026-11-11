import type { GitHubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { proceedsOnNoRepro } from "./no-repro-test-only.js";
import { CHANGESET, SPEC, TEST, gate, scene, vacuousLine } from "./no-repro-test-only.test-helpers.js";

describe("proceedsOnNoRepro on a diff of tests and a changeset", () => {
  it("lets a correctness registration proceed, since its diff makes it test-only for proof", async () => {
    expect((await proceedsOnNoRepro(scene([TEST, CHANGESET]), gate("correctness"), vacuousLine())).proceeds).toBe(true);
  });

  it("keeps a security registration gated", async () => {
    expect((await proceedsOnNoRepro(scene([TEST, CHANGESET]), gate("security"), vacuousLine())).proceeds).toBe(false);
  });

  it("keeps a correctness registration gated once the diff also changes source", async () => {
    const files = [TEST, CHANGESET, { path: "packages/x/src/view.ts", status: "modified" } as const];

    expect((await proceedsOnNoRepro(scene(files), gate("correctness"), vacuousLine())).proceeds).toBe(false);
  });

  it("keeps a correctness registration gated when its mutation spec is refused", async () => {
    const refused = vacuousLine({ verdict: "error", results: [], error: "mutants: spec refused" });

    expect((await proceedsOnNoRepro(scene([TEST, SPEC, CHANGESET]), gate("correctness"), refused)).proceeds).toBe(false);
  });

  describe("when the diff read fails", () => {
    const failing = (failures: number): GitHubPort => {
      const port = scene([TEST, CHANGESET]);
      let left = failures;
      return { ...port, listPrFiles: async (repo, pr) => (left-- > 0 ? Promise.reject(new Error("synthetic read error")) : port.listPrFiles(repo, pr)) };
    };

    it("reads the diff once more, so one failed read does not end a test-only review", async () => {
      expect(await proceedsOnNoRepro(failing(1), gate("test-only"), vacuousLine())).toEqual({ proceeds: true });
    });

    it("keeps the gate and names the failed read when the diff stays unread", async () => {
      const decision = await proceedsOnNoRepro(failing(2), gate("test-only"), vacuousLine());

      expect(decision.proceeds).toBe(false);
      expect(decision.unreadReason).toContain("changed files could not be read");
    });

    it("keeps a correctness registration's verdict the same when the diff stays unread", async () => {
      expect((await proceedsOnNoRepro(failing(2), gate("correctness"), vacuousLine())).proceeds).toBe(false);
    });

    it("records no reason for a diff that read in full as source", async () => {
      const files = [TEST, { path: "packages/x/src/view.ts", status: "modified" } as const];

      expect(await proceedsOnNoRepro(scene(files), gate("test-only"), vacuousLine())).toEqual({ proceeds: false });
    });
  });
});
