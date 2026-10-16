import { describe, expect, it } from "vitest";
import { HOUR, auditGate } from "../test-support/owner-gate-audit.js";
import { standingGrants } from "./grants.js";

const AT = Date.parse("2026-10-10T12:00:00Z");
const seat = (name: string, grants: string[]) => ({ name, remotes: [], paths: {}, grants });

describe("standingGrants", () => {
  it("lists every seat grant, then each grant only a delegate's resolve names, with the gates resolved under each", () => {
    const book = { seats: [seat("design-coord", ["merge-on-green-approve", "release-merge"])], denied: [] };
    const gates = [
      auditGate({ id: "a/approve-merge:0", resolvedAt: AT, by: "coordinator", evidence: { kind: "delegate", grant: "release-merge" } }),
      auditGate({ id: "b/approve-merge:0", resolvedAt: AT + HOUR, by: "coordinator", evidence: { kind: "delegate", grant: "item 193" } }),
      auditGate({ id: "c/approve-merge:0", resolvedAt: AT + 2 * HOUR }),
    ];

    expect(standingGrants(book, gates)).toEqual([
      { grant: "merge-on-green-approve", source: "seat:design-coord", resolved: 0, gateIds: [] },
      { grant: "release-merge", source: "seat:design-coord", resolved: 1, gateIds: ["a/approve-merge:0"] },
      { grant: "item 193", source: "delegate", resolved: 1, gateIds: ["b/approve-merge:0"] },
    ]);
  });

  it("carries no expiry on any grant, since grants do not expire", () => {
    const book = { seats: [seat("s", ["release-merge"])], denied: [] };
    const gates = [auditGate({ id: "a/approve-merge:0", resolvedAt: AT, evidence: { kind: "delegate", grant: "item 193" } })];

    for (const grant of standingGrants(book, gates)) {
      expect(grant).not.toHaveProperty("expires_at");
      expect(grant).not.toHaveProperty("expiresAt");
    }
  });
});
