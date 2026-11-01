import { expect, it } from "vitest";
import { ATTESTATIONS_PATH, LOCK_PATH, runCheck } from "./step-closure-check.mjs";

const lock = (closure) => JSON.stringify({ "ci-wait": { closure, schemaHash: "schema-1", bump: 0 } });

it("the check reads the base lock from origin/main, not the working tree", () => {
  const gitCalls = [];
  const git = (args) => {
    gitCalls.push(args.join(" "));
    return args[0] === "show" ? lock("base-closure") : "";
  };
  const files = { [LOCK_PATH]: lock("head-closure"), [ATTESTATIONS_PATH]: "[]" };

  const input = runCheck({ git, readFile: (path) => files[path], check: (received) => received, base: "origin/main" });

  expect(gitCalls).toContain(`show origin/main:${LOCK_PATH}`);
  expect(input.base["ci-wait"].closure).toBe("base-closure");
  expect(input.committed["ci-wait"].closure).toBe("head-closure");
});

it("a base with no lock yet hands the check no base", () => {
  const git = (args) => {
    if (args[0] === "show") throw new Error("path does not exist in origin/main");
    return "";
  };

  const input = runCheck({ git, readFile: (path) => (path === LOCK_PATH ? lock("head-closure") : "[]"), check: (received) => received, base: "origin/main" });

  expect(input.base).toBeUndefined();
});
