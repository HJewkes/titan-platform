import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import { checkSendBack } from "./fix-proof-sendback-check.mjs";

const POLL_MS = 30_000;
// The judge took about 6 min in the TP-2406 smoke and Shepherd's fix-proof read deadline is 25 min.
const DEFAULT_TIMEOUT_MIN = "40";
const FIXTURE_TITLE = "TP-538 fixture: never merge";
const FIXTURE_SOURCE = "scripts/tp538-fixture.mjs";
const FIXTURE_TEST = "scripts/tp538-fixture.test.mjs";
// The test never imports the source, so it passes on the merge base too and the honest verdict is `vacuous`.
const FIXTURE_FILES = {
  [FIXTURE_SOURCE]: 'export const TP538_FIXTURE = "never merge";\n',
  [FIXTURE_TEST]: 'import { expect, it } from "vitest";\n\nit("tp538 fixture passes with or without the fix", () => {\n  expect([1, 2].length).toBe(2);\n});\n',
};

export const USAGE = "usage: node scripts/smoke-fix-proof.mjs (--repo <owner/name> --pr <n> --head <40-hex sha> | --open --repo <owner/name> --implementer <agent>) [--task <slug/id>] [--timeout-min 40] [--run]";

export function options(argv) {
  const { values } = parseArgs({ args: argv, options: {
    repo: { type: "string" }, pr: { type: "string" }, head: { type: "string" }, open: { type: "boolean", default: false },
    implementer: { type: "string" }, task: { type: "string", default: "titan-platform/TP-538" },
    "timeout-min": { type: "string", default: DEFAULT_TIMEOUT_MIN }, run: { type: "boolean", default: false },
  } });
  const pr = Number(values.pr);
  const timeoutMin = Number(values["timeout-min"]);
  const repo = /^[\w.-]+\/[\w.-]+$/.test(values.repo ?? "");
  const existing = !values.open && Number.isSafeInteger(pr) && pr > 0 && /^[0-9a-f]{40}$/.test(values.head ?? "");
  const opening = values.open && values.pr === undefined && values.head === undefined && /^[\w.-]+$/.test(values.implementer ?? "");
  if (!repo || !(existing || opening) || !(timeoutMin > 0)) throw new Error(USAGE);
  return { repo: values.repo, pr: existing ? pr : null, head: values.head ?? null, open: values.open, implementer: values.implementer ?? null, task: values.task, timeoutMs: timeoutMin * 60_000, run: values.run };
}

const run = (command, args, input) => execFileSync(command, args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).trim();
const git = (args, env) => execFileSync("git", args, { encoding: "utf8", env: { ...process.env, ...env } }).trim();

/** Commits the fixture on origin/main through a scratch index, so no checkout or worktree is needed. */
function fixtureCommit() {
  git(["fetch", "origin", "main"]);
  const scratch = mkdtempSync(path.join(tmpdir(), "tp538-index-"));
  const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
  try {
    git(["read-tree", "origin/main"], env);
    for (const [file, text] of Object.entries(FIXTURE_FILES)) {
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { encoding: "utf8", input: text }).trim();
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], env);
    }
    const tree = git(["write-tree"], env);
    return git(["commit-tree", tree, "-p", "origin/main", "-m", `${FIXTURE_TITLE}\n\nA vacuous test for the TP-538 fix-proof send-back smoke.`]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function openFixture(opts) {
  const branch = `fix/tp-538-fixture-${randomBytes(3).toString("hex")}`;
  const head = fixtureCommit();
  git(["push", "origin", `${head}:refs/heads/${branch}`]);
  const body = "Fixture for the TP-538 fix-proof send-back smoke. Its test passes with and without the change. **Never merge.**";
  const created = JSON.parse(run("gh", ["api", "-X", "POST", `repos/${opts.repo}/pulls`, "-f", `title=${FIXTURE_TITLE}`, "-f", `head=${branch}`, "-f", "base=main", "-F", "draft=true", "-f", `body=${body}`]));
  return { pr: created.number, head, branch, url: created.html_url };
}

function shepherd(args) {
  return run("titan-factory", ["shepherd", ...args]);
}

/** Registers the fixture as a correctness fix that may never merge, then holds it as a second guard on the merge. */
function register(opts, fixture) {
  const ref = `${opts.repo}#${fixture.pr}`;
  shepherd(["register", ref, "--kind", "correctness", "--implementer", opts.implementer, "--task", opts.task, "--slice", "fixture", "--policy", '{"merge":"never"}']);
  shepherd(["hold", ref, "--reason", "TP-538 fixture: never merge"]);
}

function timeline(ref) {
  return JSON.parse(stripVTControlCharacters(shepherd(["timeline", ref, "--json"])));
}

async function poll(ref, head, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { row, entries } = timeline(ref);
    const result = checkSendBack(entries, head);
    if (!result.pending) return { ...result, row, tail: entries.slice(-12) };
    if (Date.now() >= deadline) return { ...result, ok: false, failures: [`still pending after ${timeoutMs / 60_000} min (phase ${row.phase}: ${row.nextAction})`], row, tail: entries.slice(-12) };
    await sleep(POLL_MS);
  }
}

function dryRun(opts) {
  const steps = opts.open
    ? ["fetch origin main", `push a fix/tp-538-fixture-<rand> commit adding ${Object.keys(FIXTURE_FILES).join(" and ")}`, `open a draft PR "${FIXTURE_TITLE}"`, `shepherd register --kind correctness --implementer ${opts.implementer} --policy {"merge":"never"}`, "shepherd hold"]
    : [];
  return { dryRun: true, note: "pass --run to act", steps: [...steps, `poll shepherd timeline every ${POLL_MS / 1000} s for up to ${opts.timeoutMs / 60_000} min`, "print PASS or FAIL"] };
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (!opts.run) return console.log(JSON.stringify(dryRun(opts), null, 2));
  const fixture = opts.open ? openFixture(opts) : { pr: opts.pr, head: opts.head };
  if (opts.open) register(opts, fixture);
  const ref = `${opts.repo}#${fixture.pr}`;
  console.log(JSON.stringify({ fixture, runId: timeline(ref).row.runId }, null, 2));
  const report = await poll(ref, fixture.head, opts.timeoutMs);
  console.log(JSON.stringify(report, null, 2));
  console.log(report.ok ? `PASS ${ref} ${fixture.head}` : `FAIL ${ref} ${fixture.head}: ${report.failures.join("; ")}`);
  console.log(`close it: gh api -X PATCH repos/${opts.repo}/pulls/${fixture.pr} -f state=closed && titan-factory shepherd resync`);
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
