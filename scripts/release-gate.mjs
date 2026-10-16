#!/usr/bin/env node
// release.yml's gate: whether this Release run versions or publishes now, written to $GITHUB_OUTPUT as run=true|false.
// Each Version Packages refresh pushes a head that runs full CI, so a burst of merges refreshes it at most once per
// DEBOUNCE_S. The hourly schedule catches up a skipped refresh, and it publishes on the bar a workflow_run publishes on:
// a green push CI run at the tip and no changeset pending. Both share one concurrency group, so a scheduled run can replace
// a queued publish run; publishing in its place keeps that publish, and `changeset publish` skips versions already on npm.
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEBOUNCE_S = 30 * 60;
const VERSION_BRANCH = "origin/changeset-release/main";

const decide = (run, reason) => ({ run, reason });

/**
 * facts: { event, tipGreen, pending, branchExists, branchHasTip, branchAgeS }. tipGreen is read only on a schedule;
 * pending counts changeset files; branchAgeS is the age of the Version Packages branch's last commit.
 */
export function releaseDecision(facts) {
  const scheduled = facts.event === "schedule";
  if (scheduled && facts.tipGreen !== true) return decide(false, "No green push CI run at the tip yet; the Release run after it decides.");
  if (facts.pending === 0) return decide(true, "No pending changeset: publish.");
  if (!facts.branchExists) return decide(true, "No Version Packages branch yet: open it.");
  if (facts.branchHasTip) return decide(false, "The Version Packages branch already contains the tip.");
  if (facts.branchAgeS < DEBOUNCE_S) return decide(false, `The Version Packages PR was refreshed ${facts.branchAgeS}s ago; the next merge after 30 minutes or the hourly run refreshes it.`);
  return decide(true, "Refresh the Version Packages PR.");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function succeeds(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/** The CI runs a push of `tip` started; the reader below holds every row to the same filter, so the query only narrows. */
export const tipRunsQuery = (repo, tip) => `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${tip}&event=push`;

/** True only when some CI run in the response is a push of `tip` that succeeded; a red, cancelled or missing run is not green. */
export function tipGreenFromRuns(responseJson, tip) {
  const runs = JSON.parse(responseJson).workflow_runs ?? [];
  return runs.some((run) => run.conclusion === "success" && run.event === "push" && run.head_sha === tip);
}

const tipGreen = (repo, tip) => tipGreenFromRuns(execFileSync("gh", ["api", tipRunsQuery(repo, tip)], { encoding: "utf8" }), tip);

function readFacts(env, now) {
  const event = env.EVENT_NAME;
  const pending = readdirSync(".changeset").filter((name) => name.endsWith(".md") && name !== "README.md").length;
  const branchExists = succeeds(() => git("rev-parse", "--verify", "-q", VERSION_BRANCH));
  const facts = { event, tipGreen: event === "schedule" ? tipGreen(env.REPO, env.TIP) : undefined, pending, branchExists };
  if (!branchExists) return facts;
  const branchHasTip = succeeds(() => git("merge-base", "--is-ancestor", env.TIP, VERSION_BRANCH));
  return { ...facts, branchHasTip, branchAgeS: Math.floor(now / 1000) - Number(git("log", "-1", "--format=%ct", VERSION_BRANCH)) };
}

function main(env) {
  const { run, reason } = releaseDecision(readFacts(env, Date.now()));
  appendFileSync(env.GITHUB_OUTPUT, `run=${run}\n`);
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${reason}\n`);
  console.log(reason);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.env);
