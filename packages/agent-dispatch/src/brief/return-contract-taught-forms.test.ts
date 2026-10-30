import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BODY_FILE_RULE,
  IMPLEMENTER_WITHOUT_SHEPHERD,
  MAX_BLOCK_CHARS,
  PROBE_SANDBOX_RULE,
  QUOTE_RULE,
  RETURN_CONTRACT_BLOCKS,
  REVIEW_TREE_RULE,
  REVIEWER_BODY_FILE_RULE,
  REVIEWER_WITHOUT_SHEPHERD,
} from "./blocks.js";

/**
 * CC-501 S3: the command forms the contract teaches are pinned as text. agent-chat's leak guard allows each of
 * them; a reworded block would have to be re-checked against that guard, so a change here fails until the golden,
 * captured from agent-chat's own blocks, is updated on purpose.
 */

interface Golden {
  maxBlockChars: number;
  implementer: string;
  implementerWithoutShepherd: string;
  reviewer: string;
  reviewerWithoutShepherd: string;
}

const golden = JSON.parse(
  readFileSync(
    new URL("./fixtures/return-contract-blocks.golden.json", import.meta.url),
    "utf8"
  )
) as Golden;

/** The commands a block shows: backticked spans that start with a command it teaches, and the CI paste. */
function shownCommands(block: string): string[] {
  const spans = [...block.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
  const paste = [...block.matchAll(/<paste of: (.+)>,/g)].map(
    (m) => m[1] ?? ""
  );
  return [
    ...spans.filter((span) =>
      /^(git|gh|agent-chat|titan-factory) |^pgrep$/.test(span)
    ),
    ...paste,
  ];
}

const HEREDOC_POST = "agent-chat gh-write -- <gh args> --body-file - <<'EOF'";

describe("the blocks are byte-identical to agent-chat's", () => {
  it.each([
    ["implementer", RETURN_CONTRACT_BLOCKS.implementer, golden.implementer],
    [
      "implementer without Shepherd",
      IMPLEMENTER_WITHOUT_SHEPHERD,
      golden.implementerWithoutShepherd,
    ],
    ["reviewer", RETURN_CONTRACT_BLOCKS.reviewer, golden.reviewer],
    [
      "reviewer without Shepherd",
      REVIEWER_WITHOUT_SHEPHERD,
      golden.reviewerWithoutShepherd,
    ],
  ])("the %s block", (_which, block, expected) => {
    expect(block).toBe(expected);
    expect(block.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
  });

  it("keeps the size cap agent-chat sets", () => {
    expect(MAX_BLOCK_CHARS).toBe(golden.maxBlockChars);
  });
});

describe("every command form the return contract teaches", () => {
  const blocks = [
    RETURN_CONTRACT_BLOCKS.implementer,
    IMPLEMENTER_WITHOUT_SHEPHERD,
    RETURN_CONTRACT_BLOCKS.reviewer,
  ];
  const forms = [...new Set(blocks.flatMap(shownCommands))];

  it("finds the forms it is meant to check", () => {
    expect(forms).toContain(HEREDOC_POST);
    expect(forms).toContain("agent-chat pr-ready --title <t> --body-file <f>");
    expect(forms).toContain('git -C "$dir"');
    expect(forms).toContain("pgrep");
    expect(
      forms.some((form) => form.startsWith("titan-factory shepherd register"))
    ).toBe(true);
    expect(forms).toContain("gh pr checks <n> --repo <owner>/<repo>");
  });

  it("teaches the stdin heredoc and never a write-then-post pair on one line", () => {
    for (const block of blocks)
      expect(block).not.toMatch(/cat >[^\n]*\.md[^\n]*gh-write/);
  });
});

describe("the body-file and quoting rules", () => {
  it.each([
    [
      "the implementer block",
      RETURN_CONTRACT_BLOCKS.implementer,
      BODY_FILE_RULE,
    ],
    [
      "the reviewer block",
      RETURN_CONTRACT_BLOCKS.reviewer,
      REVIEWER_BODY_FILE_RULE,
    ],
  ])(
    "%s carries its body-file sentence and the quoting rule",
    (_which, block, rule) => {
      expect(block).toContain(rule);
      expect(block).toContain(QUOTE_RULE);
    }
  );

  // CC-713. Mutation caught: deleting the sentence from the reviewer block.
  it("the reviewer block carries the probe-sandbox rule", () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer).toContain(PROBE_SANDBOX_RULE);
  });

  it("has the implementer delete its pr-ready file and the reviewer write none", () => {
    expect(BODY_FILE_RULE).toContain("deleted after");
    expect(REVIEWER_BODY_FILE_RULE).toContain("write no file");
  });
});

// CC-1184: base, old and head trees each installed per review exhausted /tmp inodes.
describe("one installed checkout per review", () => {
  it("the reviewer block teaches an uninstalled base tree and keeps the stash ban", () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer).toContain(REVIEW_TREE_RULE);
    expect(REVIEW_TREE_RULE).toContain("git worktree add --detach");
    expect(REVIEW_TREE_RULE).toContain("without installing");
    expect(REVIEW_TREE_RULE).toContain("never `git stash`");
    expect(REVIEW_TREE_RULE).toContain("Remove trees at verdict");
  });
});
