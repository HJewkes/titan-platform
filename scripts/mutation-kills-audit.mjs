// Lists every mutation sidecar kill that names no test its test file runs (TP-3969). fix-proof matches kills on the
// vitest full name (describe titles, then the test title), so a bare title matches nothing. Read-only: it runs each
// sidecar's test file once with the JSON reporter and compares names; it never edits a sidecar. With --base it also
// lists each sidecar whose kills name no test the diff from that base touches, so its proof is not about the change.
// Each sidecar also goes through fix-proof's own parser, so a spec CI would refuse (a name over its length cap, too many
// mutants) fails here first (TP-4165).
//
//   node scripts/mutation-kills-audit.mjs [sidecar...]               default: every tracked *.test.mutations.json
//   node scripts/mutation-kills-audit.mjs --base <ref> [sidecar...]  default: the sidecars of test files changed since <ref>

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMutationSpec } from "../packages/fix-proof/dist/index.js";
import { changedLines, missedChange, touchedTests } from "./mutation-kills-touched.mjs";

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

const git = (...args) => spawnSync("git", args, { encoding: "utf8" }).stdout;

function missedChangeOf(path, testFile, sidecar, base) {
  if (base === null) return [];
  const lines = changedLines(git("diff", "-U0", `${base}...HEAD`, "--", testFile));
  const problem = missedChange(sidecar, touchedTests(readFileSync(testFile, "utf8"), lines));
  return problem === null ? [] : [`${path}: ${problem}`];
}

/** fix-proof's refusal of a sidecar's text as one problem line, or null when fix-proof would accept it. */
export function specProblem(path, text) {
  const parsed = parseMutationSpec(text);
  return parsed.ok ? null : `${path}: ${parsed.error}`;
}

function jsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function killProblems(path, sidecar, base) {
  const testFile = testFileOf(path, existsSync);
  if (testFile === null) return [`${path}: no single test file beside it`];
  const names = namesOfRun(testFile);
  if (names === null) return [`${path}: ${testFile} collected no tests`];
  const unmatched = unmatchedKills(sidecar, names).map(({ mutation, kill }) => `${path}: mutation ${JSON.stringify(mutation)} kills ${JSON.stringify(kill)}, which names no test`);
  return [...unmatched, ...missedChangeOf(path, testFile, sidecar, base)];
}

function audit(path, base) {
  const text = readFileSync(path, "utf8");
  const refused = specProblem(path, text);
  const sidecar = jsonOrNull(text);
  const kills = sidecar === null ? [] : killProblems(path, sidecar, base);
  return [...(refused === null ? [] : [refused]), ...kills];
}

function trackedSidecars() {
  return git("ls-files", "*.test.mutations.json").split("\n").filter(Boolean);
}

/** The sidecar path beside each test file changed since `base`, whether or not it exists yet. */
function changedSidecars(base) {
  const changed = git("diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`).split("\n");
  return changed.filter((path) => /\.test\.(ts|tsx|mjs)$/.test(path)).map((path) => `${path.replace(/\.(ts|tsx|mjs)$/, "")}${SUFFIX}`);
}

function main(argv) {
  const at = argv.indexOf("--base");
  const base = at === -1 ? null : argv[at + 1];
  const args = at === -1 ? argv : argv.filter((_, index) => index !== at && index !== at + 1);
  const sidecars = args.length > 0 ? args : base === null ? trackedSidecars() : changedSidecars(base);
  const problems = sidecars.flatMap((path) => (existsSync(path) ? audit(path, base) : [`${path}: no sidecar beside a changed test file`]));
  for (const problem of problems) console.log(problem);
  console.log(`${sidecars.length} sidecars, ${problems.length} problems`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
