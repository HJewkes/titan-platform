// Compares a repo's declared toolchain (.node-version, packageManager, engines.node) against titan-platform's own
// files, which are the canonical source, and against the node and pnpm actually running on this host.
// From another repo: node <titan-platform checkout>/scripts/env-doctor.mjs --repo .
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readToolchain(dir) {
  const versionFile = path.join(dir, ".node-version");
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  return {
    nodeVersion: existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim().replace(/^v/, "") : null,
    packageManager: pkg.packageManager ?? null,
    enginesNode: pkg.engines?.node ?? null,
  };
}

function drift(subject, expected, actual, against) {
  const shown = actual === null ? "missing" : actual;
  const message = actual === null ? `${subject} is missing (${against} ${expected})` : `${subject} is ${shown}, ${against} ${expected}`;
  return { subject, expected, actual, message };
}

function differences(pairs, against) {
  return pairs.filter(([, expected, actual]) => expected !== actual).map(([subject, expected, actual]) => drift(subject, expected, actual, against));
}

export function checkRepo(repo, canonical, host) {
  const repoPairs = [
    [".node-version", canonical.nodeVersion, repo.nodeVersion],
    ["packageManager", canonical.packageManager, repo.packageManager],
    ["engines.node", canonical.enginesNode, repo.enginesNode],
  ];
  const hostPairs = [
    ["host node", repo.nodeVersion, host.node],
    ["host pnpm", repo.packageManager?.replace(/^pnpm@/, "") ?? null, host.pnpm],
  ].filter(([, expected]) => expected !== null);
  return [...differences(repoPairs, "canonical"), ...differences(hostPairs, "repo")];
}

export function hostReport(canonical, host) {
  const canonicalPnpm = canonical.packageManager.replace(/^pnpm@/, "");
  const hostPairs = [
    ["host node", canonical.nodeVersion, host.node],
    ["host pnpm", canonicalPnpm, host.pnpm],
  ];
  return {
    node: host.node,
    pnpm: host.pnpm,
    canonical: { node: canonical.nodeVersion, pnpm: canonicalPnpm, engines: canonical.enginesNode },
    drift: differences(hostPairs, "canonical"),
  };
}

export const realProbes = {
  node: () => process.versions.node,
  pnpm: () => execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
};

function probe(probes) {
  return { node: probes.node(), pnpm: probes.pnpm() };
}

export function runDoctor(argv, { probes = realProbes, canonicalRoot = PLATFORM_ROOT, log = console.log } = {}) {
  const canonical = readToolchain(canonicalRoot);
  if (argv.includes("--host")) {
    const report = hostReport(canonical, probe(probes));
    log(JSON.stringify(report));
    return report.drift.length === 0 ? 0 : 1;
  }
  const at = argv.indexOf("--repo");
  const repoDir = path.resolve(at >= 0 && argv[at + 1] ? argv[at + 1] : canonicalRoot);
  const found = checkRepo(readToolchain(repoDir), canonical, probe(probes));
  if (found.length === 0) log(`env-doctor: ok (${repoDir})`);
  for (const entry of found) log(`env-doctor: drift: ${entry.message}`);
  return found.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runDoctor(process.argv.slice(2)));
}
