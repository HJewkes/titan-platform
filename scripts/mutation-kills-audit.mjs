// Lists every mutation sidecar kill that names no test its test file runs (TP-3969). fix-proof matches kills on the
// vitest full name (describe titles, then the test title), so a bare title matches nothing. Read-only: it runs each
// sidecar's test file once with the JSON reporter and compares names; it never edits a sidecar.
//
//   node scripts/mutation-kills-audit.mjs [sidecar...]     default: every tracked *.test.mutations.json

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SUFFIX = ".mutations.json";
const TEST_EXTENSIONS = ["ts", "tsx", "mjs"];

/** The one test file beside a sidecar, as fix-proof's `testFileOfSpec` pairs them; null when none or several exist. */
export function testFileOf(sidecar, exists) {
  if (!sidecar.endsWith(SUFFIX)) return null;
  const found = TEST_EXTENSIONS.map((ext) => `${sidecar.slice(0, -SUFFIX.length)}.${ext}`).filter(exists);
  return found.length === 1 ? found[0] : null;
}

function nameOf(result) {
  if (typeof result.fullName === "string") return result.fullName;
  return [...(result.ancestorTitles ?? []), result.title].join(" ");
}

/** Every test full name a vitest JSON report holds for one file, failing or not; null when the file collected none. */
export function testNamesOf(report) {
  const names = (report?.testResults ?? []).flatMap((file) => (file.assertionResults ?? []).map(nameOf));
  return names.length > 0 ? new Set(names) : null;
}

/** `{ mutation, kill }` for each kill no name matches exactly. */
export function unmatchedKills(sidecar, names) {
  return (sidecar.mutations ?? []).flatMap((mutation) =>
    (mutation.kills ?? []).filter((kill) => !names.has(kill)).map((kill) => ({ mutation: mutation.name, kill })),
  );
}

function namesOfRun(testFile) {
  const dir = mkdtempSync(join(tmpdir(), "mutation-kills-audit-"));
  try {
    const out = join(dir, "report.json");
    spawnSync("pnpm", ["exec", "vitest", "run", "--testTimeout=30000", "--reporter=json", `--outputFile=${out}`, testFile], { stdio: "ignore" });
    return existsSync(out) ? testNamesOf(JSON.parse(readFileSync(out, "utf8"))) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function audit(path) {
  const testFile = testFileOf(path, existsSync);
  if (testFile === null) return [`${path}: no single test file beside it`];
  const names = namesOfRun(testFile);
  if (names === null) return [`${path}: ${testFile} collected no tests`];
  const sidecar = JSON.parse(readFileSync(path, "utf8"));
  return unmatchedKills(sidecar, names).map(({ mutation, kill }) => `${path}: mutation ${JSON.stringify(mutation)} kills ${JSON.stringify(kill)}, which names no test`);
}

function trackedSidecars() {
  const listed = spawnSync("git", ["ls-files", "*.test.mutations.json"], { encoding: "utf8" });
  return listed.stdout.split("\n").filter(Boolean);
}

function main(args) {
  const sidecars = args.length > 0 ? args : trackedSidecars();
  const problems = sidecars.flatMap(audit);
  for (const problem of problems) console.log(problem);
  console.log(`${sidecars.length} sidecars, ${problems.length} problems`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
