import { expect, it } from "vitest";
import { ATTESTATIONS_PATH, LOCK_PATH, readPrNumber, runCheck } from "./step-closure-check.mjs";

const lock = (closure) => JSON.stringify({ "ci-wait": { closure, schemaHash: "schema-1", bump: 0 } });
const passing = () => ({ failures: [], notices: [] });
const capture = () => {
  const seen = {};
  return { seen, check: (received) => Object.assign(seen, received) && passing() };
};

it("the check reads the base lock from origin/main, not the working tree", () => {
  const gitCalls = [];
  const git = (args) => {
    gitCalls.push(args.join(" "));
    return args[0] === "show" ? lock("base-closure") : "";
  };
  const files = { [LOCK_PATH]: lock("head-closure"), [ATTESTATIONS_PATH]: "[]" };

  const { seen: input, check } = capture();

  runCheck({ git, readFile: (path) => files[path], check, base: "origin/main" });

  expect(gitCalls).toContain(`show origin/main:${LOCK_PATH}`);
  expect(input.base["ci-wait"].closure).toBe("base-closure");
  expect(input.committed["ci-wait"].closure).toBe("head-closure");
});

it("a base with no lock yet hands the check no base", () => {
  const git = (args) => {
    if (args[0] === "show") throw new Error("path does not exist in origin/main");
    return "";
  };

  const { seen: input, check } = capture();

  runCheck({ git, readFile: (path) => (path === LOCK_PATH ? lock("head-closure") : "[]"), check, base: "origin/main" });

  expect(input.base).toBeUndefined();
});

const row = (step, closure, pr) => ({ step, closure, pr });
const CLOSURE_A = "aaaaaaaaaaaa0000000000000000";
const CLOSURE_B = "bbbbbbbbbbbb1111111111111111";

function checkRows({ baseRows, headRows, prNumber }) {
  const git = (args) => (args[0] === "show" && args[1].endsWith(ATTESTATIONS_PATH) ? JSON.stringify(baseRows) : lock("closure-1"));
  const files = { [LOCK_PATH]: lock("closure-1"), [ATTESTATIONS_PATH]: JSON.stringify(headRows) };
  return runCheck({ git, readFile: (path) => files[path], check: passing, base: "origin/main", prNumber });
}

it("an added attestation row naming another PR fails", () => {
  const result = checkRows({ baseRows: [], headRows: [row("ci-wait", CLOSURE_A, 7)], prNumber: 8 });

  expect(result.failures).toEqual(["ci-wait@aaaaaaaaaaaa: an added attestation row names PR 7, not this PR #8"]);
});

it("an added row naming this PR passes", () => {
  const result = checkRows({ baseRows: [], headRows: [row("ci-wait", CLOSURE_A, 8)], prNumber: 8 });

  expect(result.failures).toEqual([]);
  expect(result.notices).toEqual(["attest required: ci-wait@aaaaaaaaaaaa"]);
});

it("with no pull_request event the PR check is skipped", () => {
  const pushEvent = JSON.stringify({ ref: "refs/heads/main" });
  const prNumber = readPrNumber({ GITHUB_EVENT_PATH: "/event.json" }, () => pushEvent);

  const result = checkRows({ baseRows: [], headRows: [row("ci-wait", CLOSURE_A, 7)], prNumber });

  expect(prNumber).toBeUndefined();
  expect(result.failures).toEqual([]);
  expect(result.notices).toEqual(["attest required: ci-wait@aaaaaaaaaaaa"]);
});

it("a row already on the base is never re-judged", () => {
  const old = row("ci-wait", CLOSURE_A, 3);

  const result = checkRows({ baseRows: [old], headRows: [old, row("pr-open", CLOSURE_B, 8)], prNumber: 8 });

  expect(result.failures).toEqual([]);
  expect(result.notices).toEqual(["attest required: pr-open@bbbbbbbbbbbb"]);
});

it("the PR number comes from the pull_request event payload", () => {
  const event = JSON.stringify({ pull_request: { number: 42 } });

  expect(readPrNumber({ GITHUB_EVENT_PATH: "/event.json" }, () => event)).toBe(42);
  expect(readPrNumber({}, () => event)).toBeUndefined();
});
