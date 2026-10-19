#!/usr/bin/env node
// release.yml's workflow_dispatch path: publish every public workspace version that is not on npm yet, with no
// `changeset version` first. A Version Packages merge whose main CI run was cancelled by a newer push never gets its
// publish run, and once a later changeset is pending every Release run versions instead of publishing, so those versions
// stay stranded. A package npm has never seen cannot use trusted publishing until its first hand publish (CLAUDE.md), so
// it is reported and skipped, together with any package that depends on it, instead of failing the run.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/** The workspace packages `pkg` needs at install time; a dev dependency never reaches a consumer. */
const workspaceDeps = (pkg, names) =>
  [...new Set(RUNTIME_DEP_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})))].filter((dep) => names.has(dep));

/**
 * packages: [{ name, version, private, dependencies?, peerDependencies?, optionalDependencies? }].
 * published: Map of name to the versions npm has, or null when npm has never seen the package.
 * Returns { publish, neverPublished, heldBack: [{ name, version, blockedBy }], current }.
 */
export function planPublish(packages, published) {
  const candidates = packages.filter((pkg) => !pkg.private);
  const names = new Set(candidates.map((pkg) => pkg.name));
  const neverPublished = candidates.filter((pkg) => published.get(pkg.name) === null);
  const current = candidates.filter((pkg) => published.get(pkg.name)?.includes(pkg.version));
  const unavailable = new Set(neverPublished.map((pkg) => pkg.name));
  let pending = candidates.filter((pkg) => !unavailable.has(pkg.name) && !current.includes(pkg));
  const heldBack = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const pkg of pending) {
      const blockedBy = workspaceDeps(pkg, names).filter((dep) => unavailable.has(dep));
      if (blockedBy.length === 0) continue;
      heldBack.push({ name: pkg.name, version: pkg.version, blockedBy });
      unavailable.add(pkg.name);
      changed = true;
    }
    pending = pending.filter((pkg) => !unavailable.has(pkg.name));
  }
  return { publish: pending, neverPublished, heldBack, current };
}

const registryUrl = (name) => `https://registry.npmjs.org/${name.replace("/", "%2f")}`;

/** The versions npm has for `name`, or null on a 404; any other answer throws rather than guess. */
export async function fetchPublished(name, fetchImpl = fetch) {
  const response = await fetchImpl(registryUrl(name), { headers: { accept: "application/vnd.npm.install-v1+json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry answered ${response.status} for ${name}`);
  return Object.keys((await response.json()).versions ?? {});
}

/** The step summary: what publishes, what is already current, and each package skipped with the reason. */
export function renderPlan(plan, dryRun) {
  const line = (pkg) => `- ${pkg.name}@${pkg.version}`;
  return [
    `## ${dryRun ? "Dry run: would publish" : "Publishing"} ${plan.publish.length} stranded version(s)`,
    ...plan.publish.map(line),
    `## Never published: skipped, needs the first hand publish (${plan.neverPublished.length})`,
    ...plan.neverPublished.map(line),
    `## Held back: depends on a package that is not on npm (${plan.heldBack.length})`,
    ...plan.heldBack.map((pkg) => `${line(pkg)} (needs ${pkg.blockedBy.join(", ")})`),
    `Already on npm: ${plan.current.length} package(s).`,
    "",
  ].join("\n");
}

const pnpm = (args, stdio = "inherit") => execFileSync("pnpm", args, { encoding: "utf8", stdio });

function readWorkspacePackages() {
  const listed = JSON.parse(pnpm(["ls", "-r", "--json", "--depth", "-1"], ["ignore", "pipe", "inherit"]));
  return listed.map((entry) => JSON.parse(readFileSync(path.join(entry.path, "package.json"), "utf8")));
}

function publishAll(names) {
  const filters = names.flatMap((name) => ["--filter", name]);
  pnpm(["-r", ...names.flatMap((name) => ["--filter", `${name}...`]), "run", "build"]);
  pnpm(["-r", ...filters, "publish", "--access", "public", "--no-git-checks"]);
}

async function main(env) {
  const dryRun = env.DRY_RUN !== "false";
  const packages = readWorkspacePackages().filter((pkg) => !pkg.private);
  const published = new Map(await Promise.all(packages.map(async (pkg) => [pkg.name, await fetchPublished(pkg.name)])));
  const plan = planPublish(packages, published);
  const summary = renderPlan(plan, dryRun);
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  for (const pkg of [...plan.neverPublished, ...plan.heldBack]) console.log(`::warning::Skipped ${pkg.name}@${pkg.version}: not publishable by this workflow yet`);
  if (!dryRun && plan.publish.length > 0) publishAll(plan.publish.map((pkg) => pkg.name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.env);
