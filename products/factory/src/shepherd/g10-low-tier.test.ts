import { describe, expect, it } from "vitest";
import { lowTierPolicyTouch } from "./g10-low-tier.js";

const HOLD_CLOSURE_PATH = "products/factory/src/shepherd/wake-loop.ts";
const SIGNOFF_PATH = "products/factory/src/shepherd/carry-merge.ts";
const GATE_RESOLVE_ACTOR_PATH = "packages/workflow/src/runtime.ts";
/** Synthetic: matches the default `*policy*` glob and the gate-resolve actor `gate-answer-*` glob at once. */
const DEFAULT_AND_ACTOR_PATH = "products/factory/src/gate-answer-policy.ts";
const OWNER_SKILL_GUARD_PATH = "products/factory/src/shepherd/approval-carry.ts";

interface Read {
  paths: string[];
  changedLines?: number;
  unread?: string;
  ownerHold?: string;
}

const judge = ({ paths, changedLines = 40, unread, ownerHold }: Read) => lowTierPolicyTouch({ paths, changedLines, unread, ownerHold, visualPaths: ["apps/*/src/**"] });

describe("lowTierPolicyTouch, the paths that go low", () => {
  it("a hold-closure-only policy touch is low tier", () => {
    expect(judge({ paths: [HOLD_CLOSURE_PATH] })).toEqual({ eligible: true, tables: ["hold-closure"] });
  });

  it("a signoff-policy touch is low tier", () => {
    expect(judge({ paths: [SIGNOFF_PATH, HOLD_CLOSURE_PATH, "packages/store/src/a.ts"] })).toEqual({ eligible: true, tables: ["signoff-policy", "hold-closure"] });
  });
});

describe("lowTierPolicyTouch, the paths that keep the owner gate", () => {
  it("a policy touch beside an authority path keeps the owner gate", () => {
    expect(judge({ paths: [HOLD_CLOSURE_PATH, "packages/authority/src/evaluate.ts"] })).toEqual({ eligible: false, kept: "authority touch" });
  });

  it("a policy touch beside a security path keeps the owner gate", () => {
    expect(judge({ paths: [HOLD_CLOSURE_PATH, "packages/tool-guard/src/index.ts"] })).toEqual({ eligible: false, kept: "security touch" });
  });

  it("a gate-resolve-actor path keeps the owner gate", () => {
    expect(judge({ paths: [GATE_RESOLVE_ACTOR_PATH] })).toEqual({ eligible: false, kept: `high: gate-resolve file ${GATE_RESOLVE_ACTOR_PATH}` });
  });

  it("a path in both an allowed and a kept table keeps the owner gate", () => {
    expect(judge({ paths: [DEFAULT_AND_ACTOR_PATH] })).toEqual({ eligible: false, kept: `high: gate-resolve file ${DEFAULT_AND_ACTOR_PATH}` });
  });

  it("a policy table missing from the allowlist keeps the owner gate", () => {
    expect(judge({ paths: [HOLD_CLOSURE_PATH, OWNER_SKILL_GUARD_PATH] })).toEqual({ eligible: false, kept: "owner-skill-guard" });
  });

  it("more than 800 changed lines keeps the owner gate", () => {
    expect(judge({ paths: [HOLD_CLOSURE_PATH], changedLines: 801 })).toEqual({ eligible: false, kept: "medium: size: 801 changed lines, over 800" });
  });

  it("a .github path beside a policy touch keeps the owner gate", () => {
    expect(judge({ paths: [HOLD_CLOSURE_PATH, ".github/pull_request_template.md"] })).toEqual({ eligible: false, kept: "medium: .github path .github/pull_request_template.md" });
  });

  it("an unread file list keeps the owner gate", () => {
    expect(judge({ paths: [HOLD_CLOSURE_PATH], unread: "the list is truncated" })).toEqual({ eligible: false, kept: "high: changed files unread: the list is truncated" });
  });

  it("an unread registration keeps the owner gate", () => {
    expect(judge({ paths: [HOLD_CLOSURE_PATH], ownerHold: "registration unread" })).toEqual({ eligible: false, kept: "high: owner hold: registration unread" });
  });

  it("a publish file in the closure keeps the owner gate", () => {
    expect(judge({ paths: ["products/factory/src/shepherd/version-packages.ts"] })).toEqual({ eligible: false, kept: "high: publish file products/factory/src/shepherd/version-packages.ts" });
  });

  it("a PR with no policy path is no low-tier policy touch", () => {
    expect(judge({ paths: ["packages/store/src/a.ts"] })).toEqual({ eligible: false, kept: "no policy touch" });
  });
});
