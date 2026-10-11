import { accessSync, constants } from "node:fs";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";

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
  "run the full suite, typecheck, lint, dead:check and dag:check with `basement-suite <repo> <branch> --agent <your name> --run <script>`, called directly and never through ssh; `<repo>` is the repository name without its owner and `<branch>` the PR's head branch. Exit 75 means busy: retry every 5 minutes.";

/** A full suite on the Mac starves every other agent on it; basement-suite runs it on a box with slots for it. */
const macRule = (touched: string): string =>
  `Run only targeted tests on the Mac (${touched}, with \`pnpm exec vitest run <paths>\`); run typecheck, lint, build checks and the full suite with \`ssh basement basement-suite\`. Never run a full \`pnpm test\` on the Mac.`;

const basementRule = (touched: string): string => `Run only targeted tests in your checkout (${touched}, with \`timeout 300 pnpm exec vitest run <paths>\`); ${BASEMENT_SUITE_TAIL}`;

/** One install in a review checkout is about 100k inodes, and parallel reviews filled a disk; basement-suite tests in its own throwaway tree. */
const BASEMENT_REVIEWER_RULE =
  "Never install dependencies in your checkout; it is for reading. Run targeted tests (the files the PR touches) with `basement-suite <repo> <branch> --agent <your name> -- <paths>`, and check that its `head=` line is the head you review; " +
  BASEMENT_SUITE_TAIL;

export function suiteRules(onBasement: boolean): SuiteRules {
  if (onBasement) return { fixer: basementRule("the files your fix touches"), reviewer: BASEMENT_REVIEWER_RULE };
  return { fixer: macRule("the files your fix touches"), reviewer: macRule("the files the PR touches") };
}

/** What a brief built with no host wired says: the form for agents off basement. */
export const MAC_SUITE_RULES: SuiteRules = suiteRules(false);
