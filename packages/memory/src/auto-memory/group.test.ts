import { describe, expect, it } from "vitest";
import { dedupeFacts } from "./dedupe.js";
import { fact, reversedRotation } from "./facts.fixture.js";
import { groupFacts, MAX_GROUP_SIZE } from "./group.js";
import { TOPIC_FACTS } from "./topics.fixture.js";

const membership = (groups: ReturnType<typeof groupFacts>): string[][] => groups.map((group) => group.facts.map(({ fact: f }) => f.name));

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

  it("puts each topic of the fixture corpus in its own group and leaves the strays alone", () => {
    const groups = groupFacts(dedupeFacts(TOPIC_FACTS));

    expect(membership(groups)).toEqual([
      ["ci-dag-check", "ci-docs-build", "ci-flaky-retry", "ci-gate-drift", "ci-lint-warnings", "ci-named-tests", "ci-typecheck-local"],
      ["release-changeset", "release-first-publish", "release-no-token", "release-pnpm-publish", "release-trusted-publisher", "release-version-pr"],
      ["owner-question-batch", "owner-question-default", "owner-question-park", "owner-question-unlock", "owner-question-voice"],
      ["spawn-brief", "spawn-cwd", "spawn-limit", "spawn-model-tier", "spawn-trust"],
      ["rebase-conflict", "rebase-force-push", "rebase-squash", "rebase-stacked"],
      ["espresso-grind"],
      ["tomato-staking"],
      ["tubeless-sealant"],
    ]);
  });

  it("caps a group at maxGroupSize however many facts share a topic", () => {
    const facts = Array.from({ length: 30 }, (_, index) => fact(`deploy-${index}`, { description: "Deploy rollback window", body: `case k${index}` }));

    const groups = groupFacts(dedupeFacts(facts), { maxGroupSize: MAX_GROUP_SIZE });

    expect(groups.map((group) => group.facts.length)).toEqual([25, 5]);
  });

  it("forms more groups at a higher threshold", () => {
    const deduped = dedupeFacts(TOPIC_FACTS);

    expect(groupFacts(deduped, { threshold: 0.9 }).length).toBeGreaterThan(groupFacts(deduped).length);
  });

  it("returns the same fixture groups for any input order", () => {
    const deduped = dedupeFacts(TOPIC_FACTS);

    expect(groupFacts(reversedRotation(deduped))).toEqual(groupFacts(deduped));
  });

  it("never links a fact that has no topic tokens", () => {
    const facts = [fact("a", { name: "the", description: "", body: "one" }), fact("b", { name: "of", description: "", body: "two" })];

    expect(groupFacts(dedupeFacts(facts), { threshold: 0 })).toHaveLength(2);
  });
});
