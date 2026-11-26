import { describe, expect, it } from "vitest";
import { byRecDecision, byRecSubjectOfItem } from "./by-rec.js";
import { canonicalSubject, floorReason, isGuardPath, type ByRecSubject } from "./by-rec-floor.js";
import { byRecPolicySchema, type ByRecExclusion } from "./by-rec-schema.js";
import { item } from "./test-fixtures.js";

const OPENED = "2026-03-01T00:00:00.000Z";
const LATER = new Date(Date.parse(OPENED) + 48 * 3_600_000);

const policy = (exclude: ByRecExclusion[] = []) => byRecPolicySchema.parse({ schema: "titan/auto-by-rec-policy@1", mode: "live", exclude });

function subject(overrides: Partial<ByRecSubject> = {}): ByRecSubject {
  return {
    source: "deposit",
    id: "deposit:example",
    openedAt: OPENED,
    recommendation: { answer: "a", by: "example-seat" },
    kind: "decide",
    door: "two-way",
    options: ["a", "b"],
    ...overrides,
  };
}

describe("isGuardPath on a path that is not in canonical form", () => {
  it.each([
    "./packages/authority/src/table.json",
    "packages/./authority/src/table.json",
    "packages//authority/src/table.json",
    "./.github/./workflows/release.yml",
    "apps/../packages/authority/src/table.json",
    "/packages/authority/src/table.json",
    "packages\\authority\\src\\table.json",
    "./",
    "",
  ])("reads %s as guard", (path) => {
    expect(isGuardPath(path)).toBe(true);
  });

  it("still reads a dotted path outside every guard area as not guard", () => {
    expect(isGuardPath("./apps/console/web/inbox.tsx")).toBe(false);
  });
});

describe("byRecSubjectOfItem with a dot-segment anchor", () => {
  const deposit = item({
    id: "deposit:example",
    openedAt: OPENED,
    options: [{ id: "a", label: "Keep the cap" }, { id: "b", label: "Raise the cap" }],
    recommended: { optionId: "a", by: "example-seat" },
  });

  it.each(["head/./packages/authority/src/table.json#L1", "head/packages/./authority/x.ts#L1", "diff/./.github/workflows/release.yml#L2"])(
    "refuses the anchor %s as a guard path",
    (anchor) => {
      const decision = byRecDecision(byRecSubjectOfItem({ ...deposit, anchors: [anchor] }), LATER, policy());

      expect(decision).toEqual({ eligible: false, reason: "floor:guard-path" });
    },
  );
});

describe("floor on spelling variants of a refused fact", () => {
  it.each<[string, Partial<ByRecSubject>]>([
    ["g10-hold", { holdClasses: [" g10-review"] }],
    ["g10-hold", { holdClasses: ["G10-Adversary "] }],
    ["owner-at-head", { holdClasses: [" Files-Unread"] }],
    ["security-class", { decisionClass: " d1" }],
    ["guard-class", { decisionClass: "d21 " }],
    ["release", { headRef: " changeset-release/main " }],
    ["publish", { authorityRows: [" pub-priv"] }],
    ["money", { category: " Spend " }],
    ["authority-row", { authorityRows: [" mrg-au"] }],
    ["not-a-decision", { kind: " Do" }],
  ])("refuses %s on %o", (reason, overrides) => {
    expect(floorReason(subject(overrides))).toBe(reason);
    expect(byRecDecision(subject(overrides), LATER, policy())).toEqual({ eligible: false, reason: `floor:${reason}` });
  });

  it("reads the authority table name without regard to case or padding", () => {
    expect(floorReason(subject({ authorityRows: ["SPN-AU"], authorityTable: " Authority " }))).toBeUndefined();
  });

  it("is idempotent", () => {
    const once = canonicalSubject(subject({ paths: ["./a/./b.ts"], holdClasses: [" G10-x"], decisionClass: " d5", authorityRows: [" spn-au"] }));

    expect(canonicalSubject(once)).toEqual(once);
    expect(once).toMatchObject({ paths: ["a/b.ts"], holdClasses: ["g10-x"], decisionClass: "D5", authorityRows: ["SPN-AU"] });
  });
});

describe("policy exclusions on spelling variants", () => {
  it.each<[ByRecExclusion, Partial<ByRecSubject>]>([
    [{ field: "class", value: "d5" }, { decisionClass: "D5" }],
    [{ field: "authority", value: "spn" }, { authorityRows: ["SPN-AU"] }],
    [{ field: "hold", value: "Owner" }, { holdClasses: ["owner-asked"] }],
    [{ field: "path", value: "Apps/Console/" }, { paths: ["./apps/console/web/x.ts"] }],
    [{ field: "by", value: "Example-Seat" }, {}],
  ])("excludes with %o", (rule, overrides) => {
    expect(byRecDecision(subject(overrides), LATER, policy([rule]))).toEqual({ eligible: false, reason: `excluded:${rule.field}=${rule.value}` });
  });
});
