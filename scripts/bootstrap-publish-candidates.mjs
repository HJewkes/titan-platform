#!/usr/bin/env node
// First publish for packages npm has never seen. See .github/workflows/bootstrap-publish.yml.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Decide what to do with each workspace package. `view` resolves to the version npm
 * currently serves, or to null when npm answers 404. Anything else it throws, so a
 * registry hiccup stops the run instead of looking like a missing package.
 */
export async function selectCandidates(packages, view) {
  const decisions = [];
  for (const pkg of packages) {
    if (pkg.private) {
      decisions.push({ ...pkg, decision: "skipped-private" });
      continue;
    }
    const publishedVersion = await view(pkg.name);
    decisions.push(
      publishedVersion === null
        ? { ...pkg, decision: "publish" }
        : { ...pkg, decision: "skipped-exists", publishedVersion },
    );
  }
  return decisions;
}

export function readWorkspacePackages(root = ROOT) {
  return readdirSync(join(root, "packages"))
    .map((entry) => join("packages", entry))
    .filter((dir) => existsSync(join(root, dir, "package.json")))
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
      return { dir, name: manifest.name, version: manifest.version, private: Boolean(manifest.private) };
    });
}

export function selectRequested(packages, requested) {
  if (!requested) return packages;
  const matches = packages.filter((pkg) => pkg.name === requested || pkg.dir === join("packages", requested));
  if (matches.length === 0) throw new Error(`no workspace package under packages/* matches "${requested}"`);
  return matches;
}

function npmView(name) {
  try {
    return JSON.parse(execFileSync("npm", ["view", name, "version", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    if (readErrorCode(error) === "E404") return null;
    throw new Error(`npm view ${name} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

function readErrorCode(error) {
  try {
    return JSON.parse(String(error.stdout ?? "")).error?.code;
  } catch {
    return undefined;
  }
}

// pnpm, not npm: only pnpm rewrites the `workspace:` ranges in a package's deps to real versions.
function publish(pkg) {
  execFileSync("pnpm", ["publish", "--access", "public", "--no-git-checks"], {
    cwd: join(ROOT, pkg.dir),
    stdio: "inherit",
  });
}

function summarize(decision) {
  if (decision.decision === "skipped-private") return `skipped-private ${decision.name}`;
  if (decision.decision === "skipped-exists") return `skipped-exists ${decision.name} (npm has ${decision.publishedVersion})`;
  return `published ${decision.name}@${decision.version}`;
}

async function main() {
  const requested = (process.argv[2] ?? process.env.BOOTSTRAP_PACKAGE ?? "").trim();
  const packages = selectRequested(readWorkspacePackages(), requested);
  const decisions = await selectCandidates(packages, npmView);
  for (const decision of decisions) {
    if (decision.decision === "publish") publish(decision);
    console.log(summarize(decision));
  }
  if (!decisions.some((d) => d.decision === "publish")) console.log("nothing to bootstrap");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
