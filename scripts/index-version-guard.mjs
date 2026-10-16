#!/usr/bin/env node
// `pnpm index-version:check`: when a PR's own commits change code-graph's INDEX_VERSION, or a changeset the PR adds
// declares a new one, the PR's value must be strictly greater than the base branch's. Two PRs cut from the same base each pick the next version and merge
// cleanly one after the other, so the second reuses a version whose stores lack its changes (tp#1248).
// Reads BASE_REF (default origin/main) and HEAD_SHA (default HEAD); git runs in the current directory.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const INDEXER_PATH = "packages/code-graph/src/indexer.ts";
const VERSION_LINE = /^export const INDEX_VERSION = "(\d+)\.(\d+)\.(\d+)";$/m;
// Merge commits show no diff without -m, so an update-branch merge never counts as touching the line.
const TOUCH_PATTERN = "export const INDEX_VERSION";
// The phrasings changesets on main use; "stays at" and "no change (still x)" deliberately declare nothing.
const DECLARED_VERSION =
  /(?:`?INDEX_VERSION`?\s+(?:is now|moves to|goes to|bumps to)|\b[Bb]umps?\s+`?INDEX_VERSION`?\s+to)\s+(\d+\.\d+\.\d+)/g;

/** The INDEX_VERSION declared in indexer.ts source, or null when the line is missing or malformed. */
export function parseIndexVersion(source) {
  const match = VERSION_LINE.exec(source ?? "");
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** Negative, zero or positive as a is below, equal to or above b, comparing each part as a number. */
export function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Every INDEX_VERSION the given changeset texts declare, in order. */
export function changesetVersions(texts) {
  return texts.flatMap((text) => [...text.matchAll(DECLARED_VERSION)].map((match) => match[1]));
}

const nextMinor = (version) => {
  const [major, minor] = version.split(".").map(Number);
  return `${major}.${minor + 1}.0`;
};

/**
 * ok with a one-line message; a PR that bumps INDEX_VERSION must land above the base's value. `declared` holds the
 * versions the PR's added changesets announce: a rebase can empty the bump commit, but not the changeset.
 */
export function decide({ touched, base, head, declared = [] }) {
  if (base === null || head === null) {
    const side = base === null ? "base" : "head";
    return { ok: false, message: `cannot read INDEX_VERSION on the ${side} side from ${INDEXER_PATH}` };
  }
  const mismatch = declared.find((version) => version !== head);
  if (mismatch) {
    return { ok: false, message: `a changeset declares INDEX_VERSION ${mismatch} but the PR's value is ${head}` };
  }
  if (!touched && declared.length === 0) return { ok: true, message: `INDEX_VERSION untouched by this PR (base ${base}, head ${head})` };
  if (compareVersions(head, base) > 0) return { ok: true, message: `INDEX_VERSION ${head} is above base ${base}` };
  return {
    ok: false,
    message:
      `INDEX_VERSION ${head} is not above base ${base}; take the next minor above the base (${nextMinor(base)}). ` +
      "A PR that reverted its own bump still counts as touching it: bump again or squash the branch.",
  };
}

const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function readVersion(ref) {
  try {
    return parseIndexVersion(git(["show", `${ref}:${INDEXER_PATH}`]));
  } catch {
    return null;
  }
}

// --full-history: once the base holds the same bump, an update merge with the base as first parent is TREESAME to it,
// and default simplification would drop the PR's own bump commit, the very case this guard exists for.
function prTouchesVersion(baseRef, headSha) {
  const range = `${baseRef}..${headSha}`;
  const args = ["log", "--full-history", "--format=%H", `-G${TOUCH_PATTERN}`, range, "--", INDEXER_PATH];
  return git(args).trim() !== "";
}

function addedChangesetTexts(baseRef, headSha) {
  const args = ["diff", "--name-only", "--diff-filter=A", `${baseRef}...${headSha}`, "--", ".changeset/*.md"];
  const files = git(args).split("\n").filter(Boolean);
  return files.map((file) => git(["show", `${headSha}:${file}`]));
}

function main(env = process.env) {
  const baseRef = env.BASE_REF || "origin/main";
  const headSha = env.HEAD_SHA || "HEAD";
  const verdict = decide({
    touched: prTouchesVersion(baseRef, headSha),
    base: readVersion(baseRef),
    head: readVersion(headSha),
    declared: changesetVersions(addedChangesetTexts(baseRef, headSha)),
  });
  const line = `index-version:check: ${verdict.message}`;
  (verdict.ok ? console.log : console.error)(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (!verdict.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
