import { describe, expect, it } from "vitest";
import { dedupeFacts } from "./dedupe.js";
import { fact, reversedRotation } from "./facts.fixture.js";
import { groupFacts } from "./group.js";

const FACTS = [
  fact("ci-release-changeset", { description: "CI release needs a changeset" }),
  fact("coordinator-questions", { description: "Coordinator asks no blocking questions" }),
  fact("ci-release-order", { description: "CI release order matters" }),
  fact("owner-timezone", { description: "Owner lives in Pacific time" }),
  fact("coordinator-merges", { description: "Coordinator merges blocking work" }),
  fact("ci-release-token", { description: "CI release uses no token" }),
];

describe("groupFacts", () => {
  it("groups facts by shared topic tokens, largest group first, with stable labels", () => {
    const groups = groupFacts(dedupeFacts(FACTS));
    expect(groups.map((group) => [group.label, group.facts.map(({ fact: f }) => f.name)])).toEqual([
      ["ci-release-changeset", ["ci-release-changeset", "ci-release-order", "ci-release-token"]],
      ["blocking-coordinator-asks", ["coordinator-merges", "coordinator-questions"]],
      ["lives-owner-pacific", ["owner-timezone"]],
    ]);
  });

  it("returns the same groups for any input order", () => {
    const deduped = dedupeFacts(FACTS);
    expect(groupFacts(reversedRotation(deduped))).toEqual(groupFacts(deduped));
  });
});
