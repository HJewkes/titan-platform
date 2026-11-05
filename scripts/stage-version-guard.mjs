#!/usr/bin/env node
// `pnpm stage-version:check`: an explainer stage's version is a frozen base value plus a hash of the bump files that
// name it (products/explainer/stage-bumps/README.md). A version must never return to a value an older stage body
// keyed its outputs under, so against the base branch a PR may add bump files and reword their `why`, but may not
// edit a base value, delete or rename a bump, or change a bump's stages. index-version:check runs this in CI.
// Compares against the merge base of BASE_REF and HEAD_SHA. Reads BASE_REF (default origin/main) and HEAD_SHA (default HEAD); git runs in the current directory.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STAGE_SPEC_PATH = "products/explainer/src/workflow/stage-spec.ts";
export const BUMPS_DIR = "products/explainer/stage-bumps";
const BASE_MAP = /^const BASE_STAGE_VERSIONS[^=]*= \{\n([\s\S]*?)\n\};$/m;
const BASE_LINE = /^ {2}(\w+): "([^"]+)",$/;

/** The frozen base versions in stage-spec.ts source, or null when the source has no such map. */
export function parseBaseVersions(source) {
  const body = BASE_MAP.exec(source ?? "")?.[1];
  if (body === undefined) return null;
  const versions = {};
  for (const line of body.split("\n")) {
    const match = BASE_LINE.exec(line);
    if (!match) return null;
    versions[match[1]] = match[2];
  }
  return versions;
}

/** A bump file's stages, sorted so reordering them is no change, or null when the file is not a bump. */
export function parseBumpStages(text) {
  try {
    const stages = JSON.parse(text).stages;
    return Array.isArray(stages) && stages.every((stage) => typeof stage === "string") ? [...stages].sort() : null;
  } catch {
    return null;
  }
}

const sameStages = (left, right) => left.length === right.length && left.every((stage, index) => stage === right[index]);

function baseValueProblems(base, head) {
  return Object.entries(base)
    .filter(([stage, version]) => stage in head && head[stage] !== version)
    .map(([stage, version]) => `base version of ${stage} changed from ${version} to ${head[stage]}; restore it and add a bump file instead`);
}

function bumpProblems(baseBumps, headBumps) {
  const problems = [];
  for (const [id, stages] of Object.entries(baseBumps)) {
    if (!(id in headBumps)) problems.push(`bump ${id} is on the base branch but gone from this PR; a merged bump is never removed or renamed`);
    else if (headBumps[id] === null) problems.push(`bump ${id} no longer parses`);
    else if (stages !== null && !sameStages(stages, headBumps[id])) {
      problems.push(`bump ${id} changed its stages from [${stages}] to [${headBumps[id]}]; leave it and add a new bump file`);
    }
  }
  for (const [id, stages] of Object.entries(headBumps)) if (!(id in baseBumps) && stages === null) problems.push(`bump ${id} does not parse`);
  return problems;
}

/**
 * ok with a message per problem. `base`/`head` are the frozen maps (base null: the base branch predates bump files,
 * so there is nothing to protect); `baseBumps`/`headBumps` map each bump id to its sorted stages, null if unparsable.
 */
export function decide({ base, head, baseBumps, headBumps }) {
  if (head === null) return { ok: false, messages: [`cannot read BASE_STAGE_VERSIONS from ${STAGE_SPEC_PATH} on the head side`] };
  if (base === null) return { ok: true, messages: ["the base branch has no BASE_STAGE_VERSIONS yet; nothing to compare"] };
  const problems = [...baseValueProblems(base, head), ...bumpProblems(baseBumps, headBumps)];
  if (problems.length > 0) return { ok: false, messages: problems };
  const added = Object.keys(headBumps).filter((id) => !(id in baseBumps));
  return { ok: true, messages: [`stage versions only move forward (${added.length} new bump${added.length === 1 ? "" : "s"})`] };
}

const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function readFileAt(ref, file) {
  try {
    return git(["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
}

function readBumps(ref) {
  const files = git(["ls-tree", "--name-only", `${ref}`, `${BUMPS_DIR}/`]).split("\n").filter((file) => file.endsWith(".json"));
  const id = (file) => file.slice(BUMPS_DIR.length + 1, -".json".length);
  return Object.fromEntries(files.map((file) => [id(file), parseBumpStages(readFileAt(ref, file))]));
}

function main(env = process.env) {
  const baseRef = env.BASE_REF || "origin/main";
  const headSha = env.HEAD_SHA || "HEAD";
  // The merge base, not the base tip: a bump that landed on the base after this branch was cut is not a deletion here.
  const mergeBase = git(["merge-base", baseRef, headSha]).trim();
  const verdict = decide({
    base: parseBaseVersions(readFileAt(mergeBase, STAGE_SPEC_PATH)),
    head: parseBaseVersions(readFileAt(headSha, STAGE_SPEC_PATH)),
    baseBumps: readBumps(mergeBase),
    headBumps: readBumps(headSha),
  });
  const lines = verdict.messages.map((message) => `stage-version:check: ${message}`);
  for (const line of lines) (verdict.ok ? console.log : console.error)(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  if (!verdict.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
