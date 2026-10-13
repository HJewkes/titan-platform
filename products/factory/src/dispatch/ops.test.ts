import { HARD_STOP_CLASSES } from "@titan-design/coordinator";
import { describe, expect, it } from "vitest";
import {
  HARD_STOP_OPS,
  HUMAN_OPS,
  OPS,
  type Op,
  declaredOps,
  doneWhenHash,
  isHumanStep,
  opsHits,
  opsLint,
  opsNoneTag,
  publishOnlyProblem,
} from "./ops.js";

const FIXTURES: Record<Op, string> = {
  deploy: "the service deploys the build",
  restart: "live after a broker restart",
  "config-edit": "add the flag to settings.json",
  publish: "run npm publish for the package",
  spend: "purchase a larger plan",
  "force-push": "force-push the branch",
  "ruleset-write": "turn on branch protection for main",
  "dotfiles-merge": "merge the dotfiles PR",
  message: "email the vendor about the invoice",
  "personal-data": "read the lab results",
};

const FILENAME = "deploy-ports.ts isAlive is deleted";

describe("burndown ops vocabulary", () => {
  it.each(OPS)("spots the op %s in a done_when that names it", (op) => {
    expect(opsHits(FIXTURES[op]).map((hit) => hit.op)).toContain(op);
  });

  it.each(HARD_STOP_CLASSES)("maps the hard-stop class %s to an op", (name) => {
    expect(OPS).toContain(HARD_STOP_OPS[name]);
  });

  it.each([
    ["cut a release tag", ["publish"]],
    ["publishes the docs site", ["publish"]],
    ["git reset --hard origin/main", ["force-push"]],
  ])('keeps the ops a pattern finds in "%s"', (doneWhen, ops) => {
    expect([...new Set(opsHits(doneWhen).map((hit) => hit.op))]).toEqual(ops);
  });

  it("keeps publish out of the human ops, as a grant unlocks it", () => {
    expect(HUMAN_OPS).not.toContain("publish");
    expect(HUMAN_OPS).toHaveLength(OPS.length - 1);
  });

  it("resolves every hit with ops:none for the current text, even reflowed", () => {
    expect(opsLint(FILENAME, [])).toEqual([{ op: "deploy", text: "deploy" }]);
    expect(opsLint(`  deploy-ports.ts\n   isAlive  is deleted `, [opsNoneTag(FILENAME)])).toEqual([]);
  });

  it("brings the hit back when the done_when is edited under the same tag", () => {
    expect(opsLint(`${FILENAME}; deploy the merged sha`, [opsNoneTag(FILENAME)]).map((hit) => hit.op)).toEqual(["deploy"]);
  });

  it("resolves a declared op and leaves other ops unresolved", () => {
    expect(opsLint("deploy the build, then restart the broker", ["ops:deploy"])).toEqual([{ op: "restart", text: "restart the broker" }]);
  });

  it("makes the ops:none tag 8 hex digits", () => {
    expect(doneWhenHash(FILENAME)).toMatch(/^[0-9a-f]{8}$/);
    expect(opsNoneTag(FILENAME)).toBe(`ops:none=${doneWhenHash(FILENAME)}`);
  });

  it("reads declared ops from tags, skipping ops:none and unknown ops", () => {
    expect(declaredOps(["ops:deploy", "ops:none=abcd1234", "ops:teleport", "kind:bug"])).toEqual(["deploy"]);
  });

  it("calls an operator or owner task a human step and a code task not", () => {
    expect(isHumanStep(["kind:operator"])).toBe(true);
    expect(isHumanStep(["kind:owner", "p:1"])).toBe(true);
    expect(isHumanStep(["kind:bug", "ops:deploy"])).toBe(false);
  });

  it("accepts a done_when that is one publish and refuses one with another clause", () => {
    expect(publishOnlyProblem("publish @scope/pkg and @scope/other at 1.2.3")).toBeUndefined();
    expect(publishOnlyProblem("publish @scope/pkg at 1.2.3 and update the consumer")).toContain("not exactly");
  });
});
