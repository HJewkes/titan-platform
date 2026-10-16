#!/usr/bin/env node
// Checks the old-code sunset manifest (D-M0-06) against `git ls-files` of every root it covers.
// It also fails when a delete entry's file still exists after its D-task's milestone has exited (D-M0-07).
// Usage: node scripts/sunset-manifest.mjs check [--agent-chat <dir>] [--manifest <file>] [--milestones <file>]
// Without --agent-chat the agent-chat roots are checked for shape only, since CI has no checkout of that repo.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = join(ROOT, "products", "factory", "sunset", "manifest.json");
export const MILESTONES_PATH = join(ROOT, "products", "factory", "sunset", "milestones.json");
const FATES = new Set(["delete", "survives", "kept"]);
const USAGE = "usage: sunset-manifest check [--agent-chat <dir>] [--manifest <file>] [--milestones <file>]";

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "check") throw new Error(USAGE);
  const opts = { agentChat: undefined, manifest: MANIFEST_PATH, milestones: MILESTONES_PATH };
  const flags = { "--agent-chat": "agentChat", "--manifest": "manifest", "--milestones": "milestones" };
  for (let i = 0; i < rest.length; i++) {
    const key = flags[rest[i]];
    if (!key || rest[i + 1] === undefined) throw new Error(`unknown argument ${rest[i]}; ${USAGE}`);
    opts[key] = resolve(rest[++i]);
  }
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

/**
 * Problems between the manifest and the listings: `listings` maps "<repo>:<root path>" to the files git lists there,
 * or leaves a repo's roots out when its checkout is not available.
 */
export function checkManifest(manifest, listings, exited = new Set()) {
  const problems = [];
  const seen = new Set();
  for (const entry of manifest.entries) {
    const key = `${entry.repo}:${entry.path}`;
    if (seen.has(key)) problems.push(`${key}: mapped twice`);
    seen.add(key);
    const problem = entryProblem(entry);
    if (problem) problems.push(problem);
  }
  for (const { repo, path } of manifest.roots) {
    const listed = listings[`${repo}:${path}`];
    if (!listed) continue;
    for (const entry of manifest.entries) {
      const rung = milestoneOf(entry.task);
      if (entry.fate === "delete" && entry.repo === repo && listed.includes(entry.path) && exited.has(rung)) problems.push(`${repo}:${entry.path}: still exists but ${entry.task} was due at the exit of ${rung}`);
    }
    for (const file of listed) if (!seen.has(`${repo}:${file}`)) problems.push(`${repo}:${file}: unmapped`);
    const present = new Set(listed.map((file) => `${repo}:${file}`));
    for (const entry of manifest.entries) {
      const key = `${entry.repo}:${entry.path}`;
      if (entry.repo === repo && entry.path.startsWith(`${path}/`) && !present.has(key)) problems.push(`${key}: mapped but not in git`);
    }
  }
  for (const entry of manifest.entries) {
    if (!manifest.roots.some((root) => root.repo === entry.repo && entry.path.startsWith(`${root.path}/`))) problems.push(`${entry.repo}:${entry.path}: under no root`);
  }
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync(opts.manifest, "utf8"));
    const exited = exitedMilestones(JSON.parse(readFileSync(opts.milestones, "utf8")));
    const problems = checkManifest(manifest, listRoots(manifest, { "titan-platform": ROOT, "agent-chat": opts.agentChat }), exited);
    for (const problem of problems) console.error(problem);
    if (!opts.agentChat) console.error("agent-chat roots checked for shape only (no --agent-chat)");
    process.exitCode = problems.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
