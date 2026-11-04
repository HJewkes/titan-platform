import { fakeSha } from "@titan-design/github";
import { ciPolicyClass, type CiPolicyClassInput } from "./ci-policy-class.js";
import type { CiPolicyFile } from "./ci-policy-changes.js";

export const REPO = "octo/demo";
export const HEAD = fakeSha("budget-head");
export const RUN_URL = `https://github.com/${REPO}/actions/runs/123456`;
export const BODY = `Measured over 150 runs: ${RUN_URL}`;
export const BUDGET = ".github/ci-budget.json";
export const CI_YML = ".github/workflows/ci.yml";
export const REQUIRED = ["validate", "dag-check"];

export const budgetJson = (p90: number, extra = ""): string =>
  ["{", '  "workflow": "ci.yml",', '  "budgets": [', `    { "event": "pull_request", "job": "validate", "p90": ${p90} },${extra}`, '    { "event": "pull_request", "job": "dag-check", "p90": 600 }', "  ]", "}", ""].join("\n");

/** #3117's shape: validate p90 600 -> 900 s, plus a new release-PR budget entry. */
export const PR_3117: CiPolicyFile = { path: BUDGET, before: budgetJson(600), after: budgetJson(900, '\n    { "event": "release_pr", "job": "validate", "p90": 1800 },') };

export const ciYml = (jobs: string): string => `name: CI\non: pull_request\njobs:\n${jobs}`;
export const VALIDATE = "  validate:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - run: pnpm test\n";
const DAG_CHECK = "  dag-check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm dag:check\n";
export const CI_BEFORE = ciYml(VALIDATE + DAG_CHECK);

export const classOf = (files: CiPolicyFile[], overrides: Partial<CiPolicyClassInput> = {}) =>
  ciPolicyClass({ keys: ["other"], files, changedPaths: files.map((file) => file.path), unread: false, required: REQUIRED, repo: REPO, prBody: BODY, freshMerge: true, ...overrides });
