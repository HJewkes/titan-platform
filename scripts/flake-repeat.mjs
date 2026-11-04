// Repeat guard for verify:changed (TP-4657): a changed test file in a known flake class runs several times, because
// one green run of a load-dependent flake proves little. The classes are data in flake-classes.json.
import { readFileSync } from "node:fs";

// Vitest prints this banner when a run caught errors outside any test, even if every test passed.
// Matching the banner, not the bare words, keeps a test that logs "unhandled rejection" from failing the guard.
const UNHANDLED_ERRORS = /⎯ Unhandled (?:Errors?|Rejection) ⎯|Vitest caught \d+ unhandled errors?/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const MAX_REPEATS = 10;

/** `*` matches within one path segment, `**` across segments; everything else is literal. */
export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*\*\/?|\*/g, (star) => (star === "*" ? "[^/]*" : "(?:.*/)?"));
  return new RegExp(`^${source}$`);
}

/** Parses the class file and rejects a repeat count that would make the guard unbounded. */
export function parseFlakeClasses(text) {
  const data = JSON.parse(text);
  if (!Number.isInteger(data.repeats) || data.repeats < 1 || data.repeats > MAX_REPEATS) {
    throw new Error(`flake classes: repeats must be an integer from 1 to ${MAX_REPEATS}`);
  }
  const classes = data.classes.map((entry) => ({ ...entry, matchers: entry.patterns.map(globToRegExp) }));
  return { repeats: data.repeats, classes };
}

export const loadFlakeClasses = (path) => parseFlakeClasses(readFileSync(path, "utf8"));

/** The changed files some class lists, each with the id of the first class that matched it. */
export function flakeTargets(changed, classes) {
  return changed.flatMap((path) => {
    const hit = classes.find((entry) => entry.matchers.some((matcher) => matcher.test(path)));
    return hit ? [{ path, classId: hit.id }] : [];
  });
}

/** A run fails on a non-zero exit and on an unhandled-errors banner, which a passing exit can still carry. */
export function judgeRun({ status, output }) {
  if (status !== 0) return { ok: false, reason: `exit ${status}` };
  if (UNHANDLED_ERRORS.test(output.replace(ANSI, ""))) return { ok: false, reason: "unhandled errors reported" };
  return { ok: true };
}

/**
 * Runs `run(files)` up to `repeats` times and stops at the first failing run. `run` returns { status, output }.
 * No target means no run: a file outside every class already ran once in vitest related.
 */
export function repeatGuard({ targets, repeats, run }) {
  if (targets.length === 0) return { ok: true, runs: 0 };
  const files = targets.map((target) => target.path);
  for (let attempt = 1; attempt <= repeats; attempt += 1) {
    const verdict = judgeRun(run(files));
    if (!verdict.ok) return { ok: false, runs: attempt, message: `run ${attempt} of ${repeats}: ${verdict.reason}` };
  }
  return { ok: true, runs: repeats };
}
