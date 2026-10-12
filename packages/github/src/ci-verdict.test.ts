import { describe, expect, it } from "vitest";
import { ciVerdict, loadRequiredContexts } from "./ci-verdict.js";
import { fakeGitHub } from "./fake.js";
import { githubPort, type CheckRun, type CommitStatus, type RequiredChecks } from "./port.js";
import { GITHUB_ACTIONS_APP_ID as A } from "./readiness.js";

let nextId = 1;
function cr(name: string, status: string, conclusion: string | null = null, appId = A, startedAt = "2026-01-01T00:00:00Z"): CheckRun {
  return { id: nextId++, name, status, conclusion, startedAt, headSha: "", appId, workflowRunId: null, pullRequests: [], url: "" };
}
const done = (name: string, conclusion: string, appId = A, startedAt?: string) => cr(name, "completed", conclusion, appId, startedAt);
const st = (context: string, state: string): CommitStatus => ({ context, state });
const many = <T>(count: number, make: (i: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i + 1));

const NO_RULES: RequiredChecks = { contexts: [], strict: false };
function rules(...contexts: string[]): RequiredChecks {
  const pins: Record<string, number[]> = {};
  const names = contexts.map((entry) => {
    const [name, app] = entry.split(":");
    if (app) (pins[name!] ??= []).push(Number(app));
    return name!;
  });
  return { contexts: [...new Set(names)].sort(), strict: false, ...(Object.keys(pins).length > 0 ? { pins } : {}) };
}

describe("ciVerdict without required contexts", () => {
  it.each([
    ["green with check-runs only", [done("build", "success"), done("lint", "success")], []],
    ["green with skipped and neutral", [done("a", "success"), done("b", "skipped"), done("c", "neutral")], []],
    ["150 green check-runs is green", many(150, (i) => done(`ok${i}`, "success")), []],
    ["40 green statuses with a check-run is green", [done("build", "success")], many(40, (i) => st(`ok${i}`, "success"))],
  ] as const)("%s", (_name, runs, statuses) => {
    expect(ciVerdict({ rules: NO_RULES, runs, statuses })).toEqual({ verdict: "green", reasons: [] });
  });

  it.each([
    ["red naming two failing jobs", [done("ok", "success"), done("unit", "failure"), done("e2e", "timed_out")], [], ["unit=failure", "e2e=timed_out"]],
    ["red from a commit status", [done("ok", "success")], [st("ci/legacy", "failure"), st("ci/fine", "success")], ["ci/legacy=failure"]],
    ["cancelled counts as red", [done("a", "cancelled")], [], ["a=cancelled"]],
    ["150 check-runs with a failure on page 2 is red", [...many(149, (i) => done(`ok${i}`, "success")), done("late", "failure")], [], ["late=failure"]],
    ["error status on page 2 is red", [], [...many(39, (i) => st(`ok${i}`, "success")), st("late", "error")], ["late=error"]],
    ["action_required and stale are red", [done("gate", "action_required"), done("old", "stale")], [], ["gate=action_required", "old=stale"]],
    ["status error is red", [done("ok", "success")], [st("ci/legacy", "error")], ["ci/legacy=error"]],
  ] as const)("%s", (_name, runs, statuses, reasons) => {
    expect(ciVerdict({ rules: NO_RULES, runs, statuses })).toEqual({ verdict: "red", reasons });
  });

  it.each([
    ["red waits for unfinished jobs", [cr("slow", "in_progress"), done("bad", "failure")], [], ["slow"]],
    ["a queued run is pending", [cr("build", "queued")], [], ["build"]],
    ["a pending status is pending", [done("build", "success")], [st("ci/legacy", "pending")], ["ci/legacy"]],
    ["pending names every unfinished job", [cr("build", "in_progress"), cr("deploy", "queued")], [], ["build", "deploy"]],
    ["an empty list is pending", [], [], ["(nothing reported yet)"]],
    ["pending check-run on page 2 keeps waiting", [...many(149, (i) => done(`ok${i}`, "success")), cr("late", "in_progress")], [], ["late"]],
    ["40 statuses with a pending one past page 1 keeps waiting", [done("build", "success")], [...many(39, (i) => st(`ok${i}`, "success")), st("slow", "pending")], ["slow"]],
    ["40 green statuses wait for a check-run", [], many(40, (i) => st(`ok${i}`, "success")), ["(no check-run yet)"]],
    ["a status-only commit is not green", [], [st("ci/legacy", "success")], ["(no check-run yet)"]],
  ] as const)("%s", (_name, runs, statuses, reasons) => {
    expect(ciVerdict({ rules: NO_RULES, runs, statuses })).toEqual({ verdict: "pending", reasons });
  });
});

describe("ciVerdict over required contexts", () => {
  const four = rules("dag-check", "egress-scan", "validate", "hub-compose");
  const early = [done("build", "success"), done("deploy", "skipped")];

  it("is pending while only non-required runs are done", () => {
    expect(ciVerdict({ rules: four, runs: early, statuses: [] })).toEqual({ verdict: "pending", reasons: ["dag-check", "egress-scan", "hub-compose", "validate"] });
  });

  it("is pending while the required runs are queued", () => {
    const queued = [...early, cr("dag-check", "queued"), cr("validate", "queued"), cr("hub-compose", "in_progress")];

    expect(ciVerdict({ rules: four, runs: queued, statuses: [] })).toEqual({ verdict: "pending", reasons: ["dag-check", "egress-scan", "hub-compose", "validate"] });
  });

  it("is green once every required run lands green", () => {
    const landed = [...early, ...["dag-check", "validate", "hub-compose", "egress-scan"].map((name) => done(name, "success"))];

    expect(ciVerdict({ rules: four, runs: landed, statuses: [] }).verdict).toBe("green");
  });

  it("ignores a non-required run that fails or still runs", () => {
    const runs = [done("validate", "success"), done("release", "failure"), cr("slow", "in_progress")];

    expect(ciVerdict({ rules: rules("validate"), runs, statuses: [] })).toEqual({ verdict: "green", reasons: [] });
  });

  it("is red on a required failure", () => {
    const runs = [done("validate", "success"), done("lint", "failure")];

    expect(ciVerdict({ rules: rules("validate", "lint"), runs, statuses: [] })).toEqual({ verdict: "red", reasons: ["lint=failure"] });
  });

  it("judges a required context by its newest run", () => {
    const runs = [done("validate", "failure", A, "2026-01-01T00:00:00Z"), done("validate", "success", A, "2026-01-01T01:00:00Z")];

    expect(ciVerdict({ rules: rules("validate"), runs, statuses: [] }).verdict).toBe("green");
  });

  it.each(["skipped", "neutral"])("is red on a %s required context, as a merge gate judges it", (conclusion) => {
    expect(ciVerdict({ rules: rules("validate"), runs: [done("validate", conclusion)], statuses: [] })).toEqual({ verdict: "red", reasons: [`validate=${conclusion}`] });
  });

  it("does not count an unpinned required run from another app", () => {
    expect(ciVerdict({ rules: rules("validate"), runs: [done("validate", "success", 999)], statuses: [] })).toEqual({ verdict: "pending", reasons: ["validate"] });
  });

  it("is green on an unpinned required context satisfied by a commit status", () => {
    expect(ciVerdict({ rules: rules("validate"), runs: [], statuses: [st("validate", "success")] }).verdict).toBe("green");
  });

  it("is green on a pinned context from its pinned app, whatever its status says", () => {
    expect(ciVerdict({ rules: rules("validate:4242"), runs: [done("validate", "success", 4242)], statuses: [st("validate", "failure")] }).verdict).toBe("green");
  });

  it("ignores other apps and statuses for a pinned context", () => {
    const verdict = ciVerdict({ rules: rules("validate:4242"), runs: [done("validate", "success", A)], statuses: [st("validate", "success")] });

    expect(verdict).toEqual({ verdict: "pending", reasons: ["validate"] });
  });
});

describe("loadRequiredContexts", () => {
  it("reads the rulesets and skips classic protection when they require something", async () => {
    const fake = fakeGitHub();
    fake.rules = rules("validate");

    expect(await loadRequiredContexts(githubPort(fake.wire), "o/r", "main")).toEqual(rules("validate"));
    expect(fake.calls).not.toContain("getClassicRequiredChecks");
  });

  it("falls back to classic protection when the rulesets require nothing", async () => {
    const fake = fakeGitHub();
    fake.rules = NO_RULES;
    fake.classicRules = rules("lint");
    const loaded = await loadRequiredContexts(githubPort(fake.wire), "o/r", "main");

    expect(ciVerdict({ rules: loaded, runs: [done("lint", "success"), done("other", "failure")], statuses: [] }).verdict).toBe("green");
  });

  it("answers no rules when neither read requires anything, so every run counts", async () => {
    const fake = fakeGitHub();
    fake.rules = NO_RULES;
    const loaded = await loadRequiredContexts(githubPort(fake.wire), "o/r", "main");

    expect(ciVerdict({ rules: loaded, runs: [done("build", "failure")], statuses: [] })).toEqual({ verdict: "red", reasons: ["build=failure"] });
  });
});
