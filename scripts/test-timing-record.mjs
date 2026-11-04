import { execFileSync } from "node:child_process";
import { availableParallelism, hostname } from "node:os";
import { join } from "node:path";

// One versioned record per vitest run, CI or local, so a corpus can track each file across commits (TP-4465 S1).
export const TIMING_SCHEMA = "titan.test-timing/v1";
export const TIMING_FILE = "vitest-file-timing.json";

export function readGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export function runnerOf(env) {
  if (env.TITAN_TEST_TIMING_RUNNER) return env.TITAN_TEST_TIMING_RUNNER;
  return env.GITHUB_ACTIONS === "true" ? "gha" : "dev";
}

function repoOf(env, git) {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  const url = git(["config", "--get", "remote.origin.url"]);
  return url?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null;
}

const prOf = (env) => Number(env.TITAN_TEST_TIMING_PR || env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//)?.[1]) || null;

// On a pull_request run GITHUB_SHA is the merge commit GitHub made; the commit that was pushed is HEAD_SHA.
function shasOf(env, git) {
  const merge = env.GITHUB_EVENT_NAME === "pull_request" ? env.GITHUB_SHA || null : null;
  const commit = env.HEAD_SHA || env.TITAN_TEST_TIMING_COMMIT || (merge ? null : env.GITHUB_SHA) || git(["rev-parse", "HEAD"]);
  return { commit, mergeSha: merge, baseSha: env.BASE_SHA || null };
}

function branchOf(env, git) {
  return env.HEAD_REF || env.TITAN_TEST_TIMING_BRANCH || env.GITHUB_REF_NAME || git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

function runId({ env, runner, host, startedAt, pid, shard }) {
  if (runner === "gha") return `gha:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT ?? 1}:${shard?.split("/")[0] ?? 1}`;
  return `${runner}:${host}:${startedAt}:${pid}`;
}

/** The run header: who ran which commit where, under what load; every value from env, then git as a fallback. */
export function runHeader({ env = process.env, git = readGit, startedAt, scope, shard = null, maxWorkers, vitest }) {
  const runner = runnerOf(env);
  const host = env.TITAN_TEST_TIMING_HOST || hostname();
  const id = runId({ env, runner, host, startedAt, pid: process.pid, shard });
  return {
    id, runner, host, repo: repoOf(env, git), ...shasOf(env, git), branch: branchOf(env, git), pr: prOf(env),
    event: env.GITHUB_EVENT_NAME || "local", scope, shard, cpus: availableParallelism(), maxWorkers, node: process.version, vitest, startedAt,
  };
}

const fileSafe = (id) => id.replace(/[^\w.-]+/g, "_");

/**
 * Where the record goes: the spool when a runner opted in, else the CI artifact path. A plain local run with neither
 * writes nothing, so a developer's checkout gathers no stray files.
 */
export function recordPath(env, id) {
  if (env.TITAN_TEST_TIMING_SPOOL) return join(env.TITAN_TEST_TIMING_SPOOL, `${fileSafe(id)}.json`);
  if (env.VITEST_FILE_TIMING) return env.VITEST_FILE_TIMING;
  return env.CI ? TIMING_FILE : null;
}

/** os.loadavg()[0] at the start, then every interval until stop; mean and max cover every sample. */
export function sampleLoad({ loadavg, setInterval, clearInterval, everyMs = 5000 }) {
  const samples = [loadavg()];
  const timer = setInterval(() => samples.push(loadavg()), everyMs);
  timer?.unref?.();
  return () => {
    clearInterval(timer);
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const round = (value) => Math.round(value * 100) / 100;
    return { start: round(samples[0]), mean: round(mean), max: round(Math.max(...samples)) };
  };
}
