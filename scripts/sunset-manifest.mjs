#!/usr/bin/env node
// Checks the old-code sunset manifest (D-M0-06) against `git ls-files` of every root it covers.
// It also fails when a delete entry's file still exists after its D-task's milestone has exited (D-M0-07).
// Usage: node scripts/sunset-manifest.mjs check [--agent-chat <dir>] [--agent-chat-drift fail|warn] [--base <ref>] [--agent-chat-base <ref>] [--manifest <file>] [--milestones <file>]
// --base and --agent-chat-base name a ref per repo: only defaulted files added, modified or renamed since it get a per-file notice; the rest are one count line.
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
const D_TASK = /^D-M\d+[ab]?-\d+$/;
// A fold task (TP-626 and its D7-D12 children) moves agent-chat code into packages; it has no milestone of its own.
const FOLD_TASK = /^TP-\d+$/;
const USAGE = "usage: sunset-manifest check [--agent-chat <dir>] [--agent-chat-drift fail|warn] [--base <ref>] [--agent-chat-base <ref>] [--manifest <file>] [--milestones <file>]";

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "check") throw new Error(USAGE);
  const opts = { agentChat: undefined, agentChatDrift: "fail", base: undefined, agentChatBase: undefined, manifest: MANIFEST_PATH, milestones: MILESTONES_PATH };
  const flags = { "--agent-chat": "agentChat", "--agent-chat-drift": "agentChatDrift", "--base": "base", "--agent-chat-base": "agentChatBase", "--manifest": "manifest", "--milestones": "milestones" };
  for (let i = 0; i < rest.length; i++) {
    const key = flags[rest[i]];
    if (!key || rest[i + 1] === undefined) throw new Error(`unknown argument ${rest[i]}; ${USAGE}`);
    opts[key] = ["agentChatDrift", "base", "agentChatBase"].includes(key) ? rest[++i] : resolve(rest[++i]);
  }
  if (!["fail", "warn"].includes(opts.agentChatDrift)) throw new Error(`--agent-chat-drift takes fail or warn; ${USAGE}`);
  return opts;
}

/** What is wrong with one entry's fate fields, or undefined. */
function entryProblem(entry) {
  if (!FATES.has(entry.fate)) return `${entry.path}: fate "${entry.fate}" is not delete, survives or kept`;
  if (entry.fate === "kept" && !entry.reason) return `${entry.path}: kept needs a reason`;
  const task = entry.task ?? "";
  if (entry.fate !== "kept" && !D_TASK.test(task) && !FOLD_TASK.test(task)) return `${entry.path}: ${entry.fate} needs a D-task or fold id`;
  if (entry.fate === "delete" && FOLD_TASK.test(task) && entry.milestone !== "fold") return `${entry.path}: a fold id's milestone is fold`;
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

/** The directory-level default (`manifest.defaults`) a file no entry maps inherits its rung from: the deepest one covering it. */
export function defaultFor(manifest, repo, file) {
  const covering = (manifest.defaults ?? []).filter((rule) => rule.repo === repo && file.startsWith(`${rule.path}/`));
  return covering.reduce((best, rule) => (!best || rule.path.length > best.path.length ? rule : best), undefined);
}

/** Files only a default covers, as `[repo, file, rule]`. */
function defaultedFiles(manifest, listings) {
  const mapped = new Set(manifest.entries.map((entry) => `${entry.repo}:${entry.path}`));
  const found = [];
  for (const { repo, path } of manifest.roots) {
    for (const file of listings[`${repo}:${path}`] ?? []) {
      const rule = defaultFor(manifest, repo, file);
      if (rule && !mapped.has(`${repo}:${file}`)) found.push([repo, file, rule]);
    }
  }
  return found;
}

/** `defaulted: <repo>:<file> (<default path>)` lines, informational so they stay visible while their entries are owed; `changed` (a set of `<repo>:<file>`) limits them to files touched since a base, and leaving it out lists every one. */
export function defaultedNotices(manifest, listings, changed) {
  return defaultedFiles(manifest, listings)
    .filter(([repo, file]) => !changed || changed.has(`${repo}:${file}`))
    .map(([repo, file, rule]) => `defaulted: ${repo}:${file} (${rule.path})`);
}

/** The one count line for the defaulted files: how many, and the fate task each covering default hands them to; with no `changed` set (no base given) it claims nothing about changed files. */
export function defaultedSummary(manifest, listings, changed) {
  const all = defaultedFiles(manifest, listings);
  if (all.length === 0) return undefined;
  const rules = new Map(all.map(([repo, , rule]) => [`${repo}:${rule.path}`, rule]));
  const fates = [...rules].map(([key, rule]) => `${key}=${rule.task ?? rule.fate}`).sort().join(", ");
  const shown = changed ? ` (${all.filter(([repo, file]) => changed.has(`${repo}:${file}`)).length} changed since the base, listed above)` : "";
  return `defaulted: ${all.length} files covered only by a directory default${shown}; their entries are owed to the fate tasks ${fates}`;
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
    for (const file of listed) if (!seen.has(`${repo}:${file}`) && !defaultFor(manifest, repo, file)) add("drift", `${repo}:${file}: unmapped`);
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

/** `<repo>:<file>` for each file added, modified or renamed in between `base` and HEAD of a checkout; none when no base is given. */
export function changedSince(repo, repoDir, base) {
  if (!repoDir || !base) return [];
  const out = execFileSync("git", ["-C", repoDir, "diff", "--name-only", "--diff-filter=AMR", `${base}...HEAD`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter(Boolean).map((file) => `${repo}:${file}`);
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
    const changed = opts.base || opts.agentChatBase ? new Set([...changedSince("titan-platform", ROOT, opts.base), ...changedSince("agent-chat", opts.agentChat, opts.agentChatBase)]) : undefined;
    for (const line of defaultedNotices(manifest, listings, changed ?? new Set())) console.error(`::notice::${line}`);
    const summary = defaultedSummary(manifest, listings, changed);
    if (summary) console.error(`::notice::${summary}`);
    if (!opts.agentChat) console.error("agent-chat roots checked for shape only (no --agent-chat)");
    process.exitCode = problems.some((problem) => !warnOnly(problem)) ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
