import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort, type PullRequest } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { INHERITED_IDLE_MS, inheritedRedCheck } from "./inherited-red.js";
import type { ShepherdDeps } from "./phases.js";
import { lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

const REPO = "o/r";
const HEAD = fakeSha("head");
const BASE = fakeSha("base");
const BASE_PARENT = fakeSha("base-parent");
const FIXED = fakeSha("base-fixed");
const CI_STARTED = Date.parse("2026-01-01T00:00:00Z");
const at = (offsetMinutes: number) => new Date(CI_STARTED + offsetMinutes * 60_000).toISOString();
const signal = new AbortController().signal;

/** Each sha's job ids are kept apart, as GitHub's are, so each job's steps are its own. */
const runs = (failing: readonly string[], firstId: number) => ["validate", "dag-check"].map((name, i) => ({ ...successRun(name, firstId + i, undefined, failing.includes(name) ? "failure" : "success"), workflowRunId: null }));

const FAILURE = "packages/demo/src/widget.test.ts > widget > renders";

/** The jobs from `firstId` fail the same test at the same step, so the head's red repeats the base's; the log is a vitest tail. */
function jobsFail(fake: FakeGitHub, firstId: number): void {
  for (const id of [firstId, firstId + 1]) {
    fake.jobSteps.set(id, [{ name: "Set up job", conclusion: "success" }, { name: "Run pnpm test", conclusion: "failure" }]);
    fake.jobLogs.set(id, ["⎯⎯ Failed Tests 1 ⎯⎯", ` FAIL  ${FAILURE}`, "AssertionError: expected 1 to be 2", "⎯⎯[1/1]⎯", "      Tests  1 failed | 9 passed (10)"].join("\n"));
  }
}

interface Rig {
  fake: FakeGitHub;
  pr: PullRequest;
  check: (pr: PullRequest, signal: AbortSignal) => Promise<boolean>;
  advance(ms: number): void;
}

/**
 * Main ran BASE (red on `validate`) ten minutes before the head's CI started, then moved to FIXED (green): the head's
 * CI saw the red base.
 */
function rig(headFailing: readonly string[], port: (base: GitHubPort) => GitHubPort = (base) => base): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8)]);
  const store = shepherdStoreRef();
  store.bind(db);
  const fake = fakeGitHub();
  fake.setRuns(HEAD, runs(headFailing, 1));
  fake.setRuns(BASE_PARENT, runs([], 101));
  fake.setRuns(BASE, runs(["validate"], 201));
  fake.setRuns(FIXED, runs([], 301));
  fake.commits.set(BASE_PARENT, { sha: BASE_PARENT, parents: [], committedAt: at(-40) });
  fake.commits.set(BASE, { sha: BASE, parents: [BASE_PARENT], committedAt: at(-10) });
  fake.commits.set(FIXED, { sha: FIXED, parents: [BASE], committedAt: at(60) });
  fake.refs.set("main", FIXED);
  [1, 201].forEach((firstId) => jobsFail(fake, firstId));
  const pr = fake.addPr({ headSha: HEAD });
  let clock = CI_STARTED;
  const deps: ShepherdDeps = { port: port(githubPort(fake.wire)), store, now: () => clock, sleep: async (ms) => void (clock += ms), agentChatBin: "agent-chat" };
  const check = inheritedRedCheck(deps, undefined)({ repo: REPO, pr: pr.number, headSha: HEAD, failing: [...headFailing] });
  return { fake, pr, check, advance: (ms) => void (clock += ms) };
}

const callsOf = (fake: FakeGitHub, name: string) => fake.calls.filter((call) => call === name).length;

describe("the inherited-red check of a ci-red head's wait", () => {
  it("answers true once the head's CI ran against a red base that has since moved to green", async () => {
    const r = rig(["validate"]);

    expect(await r.check(r.pr, signal)).toBe(true);
  });

  it("answers false when the head fails a check that is green at the base head and at the base its CI ran against", async () => {
    const r = rig(["dag-check"]);

    expect(await r.check(r.pr, signal)).toBe(false);
  });

  it("reads only the base head while it is unchanged, and decides again once the idle backstop passes", async () => {
    const r = rig(["dag-check"]);
    await r.check(r.pr, signal);
    const heads = callsOf(r.fake, "getRef");
    const checks = callsOf(r.fake, "listCheckRuns");

    r.advance(INHERITED_IDLE_MS - 1);
    await r.check(r.pr, signal);

    expect(callsOf(r.fake, "getRef")).toBe(heads + 1);
    expect(callsOf(r.fake, "listCheckRuns")).toBe(checks);

    r.advance(1);
    await r.check(r.pr, signal);

    expect(callsOf(r.fake, "listCheckRuns")).toBeGreaterThan(checks);
  });

  it("decides again at once when the base head moves", async () => {
    const r = rig(["dag-check"]);
    await r.check(r.pr, signal);
    const checks = callsOf(r.fake, "listCheckRuns");
    const later = fakeSha("base-later");
    r.fake.setRuns(later, runs([], 401));
    r.fake.refs.set("main", later);

    await r.check(r.pr, signal);

    expect(callsOf(r.fake, "listCheckRuns")).toBeGreaterThan(checks);
  });

  it("answers false when the base head cannot be read", async () => {
    const r = rig(["validate"], (base) => ({ ...base, getHeadSha: () => Promise.reject(new Error("GitHub answered 502")) }));

    expect(await r.check(r.pr, signal)).toBe(false);
  });
});
