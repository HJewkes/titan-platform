#!/usr/bin/env node
// Checks the old-code sunset manifest (D-M0-06) against `git ls-files` of every root it covers.
// It also fails when a delete entry's file still exists after its D-task's milestone has exited (D-M0-07).
// Usage: node scripts/sunset-manifest.mjs check [--agent-chat <dir>] [--agent-chat-drift fail|warn] [--manifest <file>] [--milestones <file>]
// --agent-chat-drift warn prints drift problems found in agent-chat roots as ::warning:: lines and keeps the exit code for the rest.
// Without --agent-chat the agent-chat roots are checked for shape only, since CI has no checkout of that repo.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = join(ROOT, "products", "factory", "sunset", "manifest.json");
export const MILESTONES_PATH = join(ROOT, "products", "factory", "sunset", "milestones.json");
const FATES = new Set(["delete", "survives", "kept"]);
const USAGE = "usage: sunset-manifest check [--agent-chat <dir>] [--agent-chat-drift fail|warn] [--manifest <file>] [--milestones <file>]";

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "check") throw new Error(USAGE);
  const opts = { agentChat: undefined, agentChatDrift: "fail", manifest: MANIFEST_PATH, milestones: MILESTONES_PATH };
  const flags = { "--agent-chat": "agentChat", "--agent-chat-drift": "agentChatDrift", "--manifest": "manifest", "--milestones": "milestones" };
  for (let i = 0; i < rest.length; i++) {
    const key = flags[rest[i]];
    if (!key || rest[i + 1] === undefined) throw new Error(`unknown argument ${rest[i]}; ${USAGE}`);
    opts[key] = key === "agentChatDrift" ? rest[++i] : resolve(rest[++i]);
  }
  if (!["fail", "warn"].includes(opts.agentChatDrift)) throw new Error(`--agent-chat-drift takes fail or warn; ${USAGE}`);
  return opts;
}

/** What is wrong with one entry's fate fields, or undefined. */
function entryProblem(entry) {
  if (!FATES.has(entry.fate)) return `${entry.path}: fate "${entry.fate}" is not delete, survives or kept`;
  if (entry.fate === "kept" && !entry.reason) return `${entry.path}: kept needs a reason`;
  if (entry.fate !== "kept" && !/^D-M\d+[ab]?-\d+$/.test(entry.task ?? "")) return `${entry.path}: ${entry.fate} needs a D-task id`;
  if (entry.fate === "delete" && !entry.milestone) return `${entry.path}: delete needs the milestone of its task`;
  return undefined;
}

/** The milestone a D-task id belongs to: D-M3-12 is M3, D-M1b-02 is M1b. */
export function milestoneOf(task) {
  return /^D-(M\d+[ab]?)-\d+$/.exec(task ?? "")?.[1];
}

/** Ids of the milestones the checked-in file marks exited (`exited` is true or an exit date). */
export function exitedMilestones(milestones) {
  return new Set(milestones.milestones.filter((m) => m.exited).map((m) => m.id));
}

/** Whether a directory-level default (`manifest.defaults`) covers a file no entry maps, so a new file inherits its rung. */
function hasDefault(manifest, repo, file) {
  return (manifest.defaults ?? []).some((rule) => rule.repo === repo && file.startsWith(`${rule.path}/`));
}

/** Files only a default covers, as `defaulted: <repo>:<file> (<default path>)` lines: informational, so they stay visible while their entries are owed. */
export function defaultedNotices(manifest, listings) {
  const mapped = new Set(manifest.entries.map((entry) => `${entry.repo}:${entry.path}`));
  const lines = [];
  for (const { repo, path } of manifest.roots) {
    for (const file of listings[`${repo}:${path}`] ?? []) {
      const rule = (manifest.defaults ?? []).find((candidate) => candidate.repo === repo && file.startsWith(`${candidate.path}/`));
      if (rule && !mapped.has(`${repo}:${file}`)) lines.push(`defaulted: ${repo}:${file} (${rule.path})`);
    }
  }
  return lines;
}

function orphanProblems(manifest) {
  return manifest.entries
    .filter((entry) => !manifest.roots.some((root) => root.repo === entry.repo && entry.path.startsWith(`${root.path}/`)))
    .map((entry) => `${entry.repo}:${entry.path}: under no root`);
}

function defaultProblems(manifest) {
  const problems = [];
  for (const rule of manifest.defaults ?? []) {
    const problem = entryProblem(rule);
    if (problem) problems.push(`default ${problem}`);
    if (!manifest.roots.some((root) => root.repo === rule.repo && (rule.path === root.path || rule.path.startsWith(`${root.path}/`)))) problems.push(`${rule.repo}:${rule.path}: default under no root`);
  }
  return problems;
}

/**
 * Problems between the manifest and the listings: `listings` maps "<repo>:<root path>" to the files git lists there,
 * or leaves a repo's roots out when its checkout is not available.
 */
export function checkManifest(manifest, listings, exited = new Set()) {
  return classifyManifest(manifest, listings, exited).map((problem) => problem.text);
}

/** The same problems as checkManifest, each tagged `overdue` (a delete past its milestone exit), `drift` (a root and the manifest disagree) or `shape` (a malformed entry). */
export function classifyManifest(manifest, listings, exited = new Set()) {
  const problems = [];
  const add = (kind, text) => problems.push({ kind, text });
  const seen = new Set();
  for (const entry of manifest.entries) {
    const key = `${entry.repo}:${entry.path}`;
    if (seen.has(key)) add("shape", `${key}: mapped twice`);
    seen.add(key);
    const problem = entryProblem(entry);
    if (problem) add("shape", problem);
  }
  for (const { repo, path } of manifest.roots) {
    const listed = listings[`${repo}:${path}`];
    if (!listed) continue;
    for (const entry of manifest.entries) {
      const rung = milestoneOf(entry.task);
      if (entry.fate === "delete" && entry.repo === repo && listed.includes(entry.path) && exited.has(rung)) add("overdue", `${repo}:${entry.path}: still exists but ${entry.task} was due at the exit of ${rung}`);
    }
    for (const file of listed) if (!seen.has(`${repo}:${file}`) && !hasDefault(manifest, repo, file)) add("drift", `${repo}:${file}: unmapped`);
    const present = new Set(listed.map((file) => `${repo}:${file}`));
    for (const entry of manifest.entries) {
      const key = `${entry.repo}:${entry.path}`;
      if (entry.repo === repo && entry.path.startsWith(`${path}/`) && !present.has(key)) add("drift", `${key}: mapped but not in git`);
    }
  }
  for (const text of [...defaultProblems(manifest), ...orphanProblems(manifest)]) add("shape", text);
  return problems;
}

function gitFiles(repoDir, path) {
  return execFileSync("git", ["-C", repoDir, "ls-files", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
}

export function listRoots(manifest, repoDirs) {
  const listings = {};
  for (const { repo, path } of manifest.roots) if (repoDirs[repo]) listings[`${repo}:${path}`] = gitFiles(repoDirs[repo], path);
  return listings;
}

/** An agent-chat checkout whose every root lists nothing is an empty or moved clone; its mapped files would only warn as drift, so the check names it itself. */
export function emptyCheckoutProblem(manifest, listings) {
  const listed = manifest.roots.filter(({ repo, path }) => repo === "agent-chat" && listings[`${repo}:${path}`]);
  return listed.length > 0 && listed.every(({ repo, path }) => listings[`${repo}:${path}`].length === 0) ? "agent-chat: every root lists 0 files; the --agent-chat checkout is empty or moved" : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync(opts.manifest, "utf8"));
    const exited = exitedMilestones(JSON.parse(readFileSync(opts.milestones, "utf8")));
    const listings = listRoots(manifest, { "titan-platform": ROOT, "agent-chat": opts.agentChat });
    const problems = classifyManifest(manifest, listings, exited);
    const empty = emptyCheckoutProblem(manifest, listings);
    if (empty) problems.push({ kind: "empty", text: empty });
    const warnOnly = (problem) => opts.agentChatDrift === "warn" && problem.kind === "drift" && problem.text.startsWith("agent-chat:");
    for (const problem of problems) console.error(warnOnly(problem) ? `::warning::${problem.text}` : problem.text);
    const defaulted = defaultedNotices(manifest, listings);
    for (const line of defaulted) console.error(`::notice::${line}`);
    if (defaulted.length > 0) console.error(`::notice::defaulted: ${defaulted.length} files covered only by a directory default; TP-3180 stays open while any is listed`);
    if (!opts.agentChat) console.error("agent-chat roots checked for shape only (no --agent-chat)");
    process.exitCode = problems.some((problem) => !warnOnly(problem)) ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
