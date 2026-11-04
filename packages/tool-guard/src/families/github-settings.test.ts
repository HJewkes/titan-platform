import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifiedAction, ClassifyContext } from "../types.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const API = "https://api.github.com";

function fakeContext(): ClassifyContext {
  return { home: HOME, readLink: () => null, readHead: (dir) => (dir === REPO ? "feat/x" : null), readScript: () => null };
}

function bash(command: string): ClassifiedAction[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, fakeContext());
}

const settings = (actions: ClassifiedAction[]) => actions.filter((a) => a.spelling.endsWith("-ruleset"));

const METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const DONE_WHEN_ROUTES = [
  ["repos/o/r/rulesets/42", "repo"],
  ["repositories/123/rulesets", "repository-id"],
  ["orgs/o/rulesets/7", "org"],
] as const;

describe("one fixture per GitHub settings spelling", () => {
  it.each([
    ["bash.config.gh-api-ruleset", "gh api -X DELETE repos/o/r/rulesets/42", { pattern: "github:rulesets", scope: "repo" }],
    ["bash.config.curl-api-ruleset", `curl -X PUT ${API}/orgs/o/rulesets/7`, { pattern: "github:rulesets", scope: "org" }],
  ])("%s: %s", (spelling, command, subject) => {
    const actions = bash(command);

    expect(actions).toContainEqual(expect.objectContaining({ action: "authority-config", spelling, subject }));
  });
});

describe("githubSettings, a REST write to a ruleset", () => {
  const rows = DONE_WHEN_ROUTES.flatMap(([path, scope]) =>
    METHODS.flatMap((m) => [
      ["bash.config.gh-api-ruleset", `gh api -X ${m} ${path}`, scope],
      ["bash.config.curl-api-ruleset", `curl -X ${m} ${API}/${path}`, scope],
      ["bash.config.curl-api-ruleset", `wget --method=${m} ${API}/${path}`, scope],
    ]),
  );

  it.each(rows)("%s: %s", (spelling, command, scope) => {
    expect(settings(bash(command))).toEqual([expect.objectContaining({ spelling, subject: { pattern: "github:rulesets", scope } })]);
  });

  it.each([
    ["bash.config.gh-api-ruleset", "gh api repos/o/r/rulesets -f name=x", "repo"],
    ["bash.config.gh-api-ruleset", "gh api --method=put repos/o/r/rulesets/1 --input r.json", "repo"],
    ["bash.config.gh-api-ruleset", "gh api enterprises/e/rulesets -F enforcement=active", "enterprise"],
    ["bash.config.gh-api-ruleset", `gh api -X "$M" repos/o/r/rulesets/1`, "repo"],
    ["bash.config.gh-api-ruleset", "gh api -X PATCH repos/o/r/x/../rulesets/1", "unknown"],
    ["bash.config.curl-api-ruleset", `http DELETE ${API}/repos/o/r/rulesets/1`, "repo"],
    ["bash.config.curl-api-ruleset", `https PUT ${API}/repos/o/r/rulesets/1 name=x`, "repo"],
    ["bash.config.curl-api-ruleset", `curl -X "$M" ${API}/repos/o/r/rulesets/1`, "repo"],
    ["bash.config.curl-api-ruleset", `curl -d @r.json ${API}/repos/o/r/rule%73ets`, "repo"],
  ])("%s: %s", (spelling, command, scope) => {
    expect(settings(bash(command))).toEqual([expect.objectContaining({ spelling, subject: { pattern: "github:rulesets", scope } })]);
  });
});

describe("githubSettings, a REST write to branch protection on any branch", () => {
  it.each([
    ["bash.config.gh-api-ruleset", "gh api -X DELETE repos/o/r/branches/main/protection"],
    ["bash.config.gh-api-ruleset", "gh api -X DELETE repos/o/r/branches/feat/x/protection"],
    ["bash.config.gh-api-ruleset", "gh api -X POST repos/o/r/branches/main/protection/enforce_admins"],
    ["bash.config.curl-api-ruleset", `curl -X PUT ${API}/repos/o/r/branches/main/protection -d @p.json`],
    ["bash.config.curl-api-ruleset", `wget --method=DELETE ${API}/repos/o/r/branches/release/2.0/protection`],
  ])("%s: %s", (spelling, command) => {
    expect(settings(bash(command))).toEqual([expect.objectContaining({ spelling, subject: { pattern: "github:branch-protection", scope: "repo" } })]);
  });
});

describe("githubSettings, a request that writes no ruleset or protection", () => {
  it.each([
    "gh api repos/o/r/rulesets",
    "gh api repos/o/r/rulesets/1 --jq .name",
    "gh api -X GET orgs/o/rulesets -f per_page=100",
    "gh api repos/o/r/branches/main/protection",
    "gh ruleset list",
    "gh rs view 1",
    "gh ruleset check main",
    "gh api -X POST repos/o/r/issues -f title=rulesets",
    "gh api -X POST repos/o/r/rulesetsx",
    `curl ${API}/orgs/o/rulesets`,
    `curl -I ${API}/repos/o/r/rulesets/1`,
    `wget -q ${API}/repos/o/r/rulesets`,
    `http ${API}/repos/o/r/rulesets`,
    `curl -X POST ${API}/repos/o/r/rulesets-foo`,
  ])("passes %s", (command) => {
    expect(settings(bash(command))).toEqual([]);
  });
});

const noFiles: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};

const port: HookPort = { context: nodeContext(HOME, noFiles), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function hook(command: string): Promise<string> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "sess-1", tool_use_id: "tu-1", cwd: REPO, tool_input: { command } });
  return (await handle(input, {}, port)).stdout;
}

describe("handle: a GitHub settings write", () => {
  it.each([
    ["gh api -X DELETE repos/o/r/rulesets/42", "bash.config.gh-api-ruleset"],
    [`curl -X PUT ${API}/orgs/o/rulesets/7 -d @r.json`, "bash.config.curl-api-ruleset"],
  ])("denies %s", async (command, spelling) => {
    const stdout = await hook(command);

    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain(spelling);
  });

  it("lets a ruleset read through", async () => {
    expect(await hook("gh api repos/o/r/rulesets")).toBe("");
  });
});
