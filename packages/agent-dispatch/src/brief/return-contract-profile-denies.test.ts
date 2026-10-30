import { describe, expect, it } from "vitest";
import {
  IMPLEMENTER_WITHOUT_SHEPHERD,
  RETURN_CONTRACT_BLOCKS,
  REVIEWER_WITHOUT_SHEPHERD,
  type ReturnContract,
} from "./blocks.js";
import { contractOf, type ContractProfile } from "./return-contract.js";

/**
 * CC-1384: the contract told every implementer to run `gh api` reads that the bd-* profiles deny,
 * which cost 1,706 headless refusals in a week. Every command a block tells an agent to run is
 * checked against the denies of each profile that block is appended for.
 */

const BLOCKS: Record<ReturnContract, readonly string[]> = {
  implementer: [
    RETURN_CONTRACT_BLOCKS.implementer,
    IMPLEMENTER_WITHOUT_SHEPHERD,
  ],
  reviewer: [RETURN_CONTRACT_BLOCKS.reviewer, REVIEWER_WITHOUT_SHEPHERD],
};

/** The denies the bd-* templates carry for gh, as a fixture that does not move when a template does. */
const SYNTHETIC: ContractProfile = {
  name: "zz-implementer",
  allowedTools: ["Read", "Write", "Edit", "Bash"],
  disallowedTools: [
    "Bash(gh api:*)",
    "Bash(gh repo:*)",
    "Bash(gh pr merge:*)",
    "Bash(agent-chat agent:*)",
  ],
  returnContract: "implementer",
};

/** The bd-* templates' gh denies and agent-chat's built-in profiles' agent-chat denies, as fixtures. */
const REVIEWER_LIKE: ContractProfile = {
  name: "zz-reviewer",
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  disallowedTools: [
    "Write",
    "Edit",
    "Bash(git stash:*)",
    "Bash(gh api:*)",
    "Bash(gh repo:*)",
    "Bash(agent-chat agent:*)",
  ],
};

const FILLS: Record<string, string> = {
  "<owner>/<repo>": "example/repo",
  "<head>": "a".repeat(40),
  "<n>": "1",
  "<run>": "2",
  "<id>": "3",
};

const fill = (form: string): string =>
  Object.entries(FILLS).reduce(
    (text, [from, to]) => text.replaceAll(from, to),
    form
  );

const COMMAND = /^(?:git|gh|agent-chat|titan-factory|sed|pgrep)\b/;
const FORBIDDING = /(?:never|not run)\s+$/i;

/** Backticked commands the block tells the agent to run, not ones it forbids, and the CI paste. */
function toldCommands(block: string): string[] {
  const spans = [...block.matchAll(/`([^`]+)`/g)]
    .filter((m) => !FORBIDDING.test(block.slice(0, m.index)))
    .map((m) => m[1] ?? "")
    .filter((span) => COMMAND.test(span));
  const paste = [...block.matchAll(/<paste of: (.+)>,/g)].map(
    (m) => m[1] ?? ""
  );
  return [...spans, ...paste].map(fill);
}

const escape = (text: string): string =>
  text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Claude Code's Bash rule forms: `x:*` is x or x and more after a space; elsewhere `*` matches anything. */
function denies(rule: string, command: string): boolean {
  const body = /^Bash\((.*)\)$/s.exec(rule)?.[1];
  if (body === undefined) return false;
  if (body.endsWith(":*")) {
    const prefix = body.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return new RegExp(`^${body.split("*").map(escape).join(".*")}$`, "s").test(
    command
  );
}

const deniedBy = (profile: ContractProfile, command: string): string[] =>
  (profile.disallowedTools ?? []).filter((rule) => denies(rule, command));

const contracted = [SYNTHETIC, REVIEWER_LIKE].flatMap((profile) => {
  const contract = contractOf(profile);
  return contract === undefined ? [] : [{ profile, contract }];
});

describe("every command the return contract tells an agent to run is one its profile allows", () => {
  it("checks both contracts", () => {
    expect(contracted.map(({ contract }) => contract).sort()).toEqual([
      "implementer",
      "reviewer",
    ]);
  });

  it("finds the commands it is meant to check", () => {
    const told = BLOCKS.implementer.flatMap(toldCommands);

    expect(told).toContain("gh pr checks 1 --repo example/repo");
    expect(told).toContain(
      "gh run view 2 --repo example/repo --job 3 --log-failed"
    );
    expect(BLOCKS.reviewer.flatMap(toldCommands)).not.toContain("git stash");
  });

  it("reads a deny the way Claude Code does", () => {
    expect(
      deniedBy(SYNTHETIC, "gh api repos/example/repo --jq .visibility")
    ).toEqual(["Bash(gh api:*)"]);
    expect(deniedBy(SYNTHETIC, "gh apix")).toEqual([]);
    expect(denies("Bash(git push * --force)", "git push origin --force")).toBe(
      true
    );
  });

  it.each(
    contracted.map(
      ({ profile, contract }) => [profile.name, contract, profile] as const
    )
  )("%s (%s block)", (_name, contract, profile) => {
    const refused = BLOCKS[contract]
      .flatMap(toldCommands)
      .flatMap((command) =>
        deniedBy(profile, command).map((rule) => `${command} <- ${rule}`)
      );

    expect(refused).toEqual([]);
  });
});
