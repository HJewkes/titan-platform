import { describe, expect, it } from "vitest";
import { RUN_URL, CI_YML, PR_3117, ciYml, CI_BEFORE, classOf } from "./ci-policy-budget.test-helpers.js";

describe("judging a weakened CI-policy diff by its parsed structure", () => {
  it("reads a step timeout added and a comment edited beside a job timeout bump as budget", () => {
    const after = CI_BEFORE.replace("timeout-minutes: 20\n", "timeout-minutes: 30 # raised\n").replace("      - run: pnpm test\n", "      - run: pnpm test\n        timeout-minutes: 15\n");

    expect(classOf([{ path: CI_YML, before: CI_BEFORE, after }])).toEqual({ kind: "budget", measurement: RUN_URL });
  });

  it.each<[string, string, string]>([
    ["a top-level timeout-minutes", `timeout-minutes: 5\n${CI_BEFORE}`, `${CI_YML} changes more than its jobs' timeouts`],
    ["a job timeout re-indented under jobs", CI_BEFORE.replace("    timeout-minutes: 20\n", "").replace("  dag-check:", "  timeout-minutes: 20\n  dag-check:"), `${CI_YML} changes its job ids`],
    ["an env TIMEOUT: 0", CI_BEFORE.replace("    timeout-minutes: 20\n", "    timeout-minutes: 30\n    env:\n      TIMEOUT: 0\n"), `${CI_YML} changes more than a timeout of job validate`],
    ["a duplicate timeout key", CI_BEFORE.replace("    timeout-minutes: 20\n", "    timeout-minutes: 30\n    timeout-minutes: 0\n"), `${CI_YML} is not a workflow that parses at base and head`],
    ["a removed timeout", CI_BEFORE.replace("    timeout-minutes: 20\n", "").replace("    steps:\n      - run: pnpm dag", "    timeout-minutes: 9\n    steps:\n      - run: pnpm dag"), `${CI_YML} changes a timeout to something other than whole minutes of job validate`],
    ["continue-on-error", CI_BEFORE.replace("timeout-minutes: 20\n", "timeout-minutes: 30\n    continue-on-error: true\n"), `${CI_YML} changes more than a timeout of job validate`],
    ["if: false", CI_BEFORE.replace("timeout-minutes: 20\n", "timeout-minutes: 30\n    if: false\n"), `${CI_YML} changes more than a timeout of job validate`],
    ["a changed run command", CI_BEFORE.replace("timeout-minutes: 20", "timeout-minutes: 30").replace("pnpm test", "echo ok"), `${CI_YML} changes more than a timeout of job validate`],
  ])("reads a workflow by its parsed structure, so %s is weakening", (_case, after, why) => {
    expect(classOf([{ path: CI_YML, before: CI_BEFORE, after }])).toEqual({ kind: "weakening", why });
  });

  it("reads a timeout set on a job that calls a reusable workflow as weakening", () => {
    const before = ciYml("  validate:\n    uses: ./.github/workflows/reusable.yml\n");
    const after = before.replace("    uses:", "    timeout-minutes: 30\n    uses:");

    expect(classOf([{ path: CI_YML, before, after }], { required: [] })).toEqual({ kind: "weakening", why: `${CI_YML} changes a timeout on a job that calls a reusable workflow of job validate` });
  });

  it("reads a .github/ file with no structural reader beside a budget bump as weakening", () => {
    const checks = { path: ".github/fix-proof.json", before: '{ "timeout": 10 }', after: '{ "timeout": 20 }' };

    expect(classOf([PR_3117, checks])).toEqual({ kind: "weakening", why: ".github/fix-proof.json is not the budget data file or a workflow, so its change is not read as budget" });
  });
});
