import { accessSync, constants } from "node:fs";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import { CI_REVIEWER_TEST_RULE } from "@titan-design/review-panel";

/** The test rule each brief carries, chosen by the host serve runs on, since its reviewers and fixers run there too. */
export interface SuiteRules {
  fixer: string;
  reviewer: string;
}

const BASEMENT_HOST = "basement";
const SUITE_BIN = "basement-suite";

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True on basement itself, where `ssh basement` fails host key verification, so basement-suite must be called directly. */
export function localBasementSuite(env: NodeJS.ProcessEnv = process.env, host: string = hostname()): boolean {
  if (host === BASEMENT_HOST) return true;
  return (env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && executable(join(dir, SUITE_BIN)));
}

const BASEMENT_SUITE_TAIL =
  "run the full suite, typecheck, lint and dag:check (which also runs dead:check on the same graph, so never run dead:check separately) with `basement-suite <repo> <branch> --agent <your name> --run <script>`, called directly and never through ssh; `<repo>` is the repository name without its owner and `<branch>` the PR's head branch. Exit 75 means busy: retry every 5 minutes.";

/** `test:affected` follows the import graph from the change set, so a fixer gets the tests its edit can break without a full suite. */
const AFFECTED_TESTS = "`pnpm test:affected` where the repo has that script, else the files your fix touches";

/** A full suite on the Mac starves every other agent on it; basement-suite runs it on a box with slots for it. */
const MAC_FIXER_RULE = `Run only the tests your fix affects on the Mac (${AFFECTED_TESTS}, with \`pnpm exec vitest run <paths>\`); run typecheck, lint, build checks and the full suite with \`ssh basement basement-suite\`. Never run a full \`pnpm test\` on the Mac.`;

const BASEMENT_FIXER_RULE = `Run only the tests your fix affects in your checkout (${AFFECTED_TESTS}, with \`timeout 300 pnpm exec vitest run <paths>\`); ${BASEMENT_SUITE_TAIL}`;

/** Reviewers test nowhere, on either host: they read the CI check-runs at the head they review. */
export function suiteRules(onBasement: boolean): SuiteRules {
  return { fixer: onBasement ? BASEMENT_FIXER_RULE : MAC_FIXER_RULE, reviewer: CI_REVIEWER_TEST_RULE };
}

/** What a brief built with no host wired says: the form for agents off basement. */
export const MAC_SUITE_RULES: SuiteRules = suiteRules(false);
