import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BODY_FILE_RULE,
  FOLLOW_UPS_RULE,
  IMPLEMENTER_WITHOUT_SHEPHERD,
  MAX_BLOCK_CHARS,
  MUTANT_RULE,
  PROBE_SANDBOX_RULE,
  QUOTE_RULE,
  RETURN_CONTRACT_BLOCKS,
  RETURN_CONTRACTS,
  REVIEWER_BODY_FILE_RULE,
  REVIEWER_WITHOUT_SHEPHERD,
  SHEPHERD_NONE_MARKER,
  VISIBILITY_PLACEHOLDER,
  type ReturnContract,
} from "./blocks.js";
import {
  carriesContract,
  contractOf,
  visibilityLine,
  withReturnContract,
  type ContractProfile,
} from "./return-contract.js";
import type { RepoVisibility } from "./lint.js";

/**
 * CC-286. The return contract that fits the profile is appended once, with the spawner's name in it. These tests
 * run `withReturnContract` on profile stand-ins for agent-chat's built-in and installed ones.
 */

const WRITER = { allowedTools: ["Read", "Write", "Edit", "Bash"] };
const READER = {
  allowedTools: ["Read", "Bash"],
  disallowedTools: ["Write", "Edit"],
};

const profile = (
  name: string,
  body: Omit<ContractProfile, "name">
): ContractProfile => ({ name, ...body });

/** Profiles as agent-chat resolves them: the built-ins by name, and a user's installed files. */
const PROFILES: Record<string, ContractProfile> = Object.fromEntries(
  [
    profile("implementer", WRITER),
    profile("reviewer", READER),
    profile("explorer", READER),
    profile("planner", READER),
    profile("peer", { ...WRITER, role: "coordinator" }),
    profile("zz-implementer", WRITER),
    profile("zz-implementer-lite", WRITER),
    profile("zz_implementer", WRITER),
    profile("zz-reviewer", READER),
    profile("researcher", READER),
    profile("builder", WRITER),
    profile("lead-implementer", { ...WRITER, role: "coordinator" }),
    profile("declared-builder", { ...WRITER, returnContract: "implementer" }),
    profile("quiet-reviewer", { ...READER, returnContract: "none" }),
  ].map((p) => [p.name, p])
);

interface Spawn {
  profile?: string;
  brief?: string;
  requestedBy?: string;
  returnContract?: "none";
  visibility?: RepoVisibility;
  name?: string;
  predecessor?: string;
}

/** What the agent is handed for a spawn of `over`. */
async function delivered(
  over: Spawn = {}
): Promise<{ text: string; warnings: string[] }> {
  const result = withReturnContract({
    brief: over.brief ?? "add the parser",
    profile: PROFILES[over.profile ?? "implementer"]!,
    spawner: over.requestedBy ?? "coord",
    resumed: false,
    ...(over.returnContract === undefined
      ? {}
      : { requested: over.returnContract }),
    ...(over.visibility === undefined ? {} : { visibility: over.visibility }),
  });
  return { text: result.brief, warnings: result.warnings };
}

/** As delivered with no visibility read, which is every spawn here but CC-1384's own. */
const filled = (text: string, spawner = "coord"): string =>
  text
    .split("<spawner>")
    .join(spawner)
    .replace(VISIBILITY_PLACEHOLDER, visibilityLine());

const block = (contract: ReturnContract, spawner = "coord"): string =>
  filled(RETURN_CONTRACT_BLOCKS[contract], spawner);

const flat = (text: string): string => text.replace(/\s+/g, " ");

/** Counted with whitespace collapsed, because a pasted block is rewrapped. */
const occurrences = (text: string, part: string): number =>
  flat(text).split(flat(part)).length - 1;

/** One phrase per contract that only that contract's block contains. */
const MARKER: Record<ReturnContract, string> = {
  implementer: "LAST action must be chat_send to",
  reviewer: "Verdict: MERGE",
};

const PASTED_WARNING =
  /already carries the (implementer|reviewer) return contract/;
const OWN_FORMAT_WARNING = /has a Status: or Verdict: line of its own/;

/** The block as the skill file carried it before this change, filled in the way a coordinator pasted it. */
const OLDER_IMPLEMENTER_BLOCK = [
  "Check `gh api repos/acme/widgets --jq .visibility`. In a public repo, never commit or paste captured",
  "real data into code, fixtures, PR bodies or comments. First run `git log origin/main --oneline --grep WX-1`",
  "and stop if it has landed. Make GitHub writes through `agent-chat gh-write -- <gh args>` when",
  '`agent-chat gh-write --help` works; otherwise, on a 403 "API rate limit exceeded" with core quota left,',
  'wait 5 minutes and retry once. You are NOT done at "PR opened". Your LAST action must be',
  "chat_send to coord starting with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`,",
  "`PR: acme/widgets#<n>` and `Head: <full sha>` lines, then CI status.",
].join("\n");

const OLDER_REVIEWER_BLOCK = [
  "Your LAST action is chat_send to coord starting with exactly these three lines:",
  "Verdict: MERGE            (or FIX_FIRST)",
  "PR: acme/widgets#7",
  "Head: <full 40-hex head sha you reviewed>",
  "then blocking items before nits. Under 1,200 characters.",
].join("\n");

const STATUS = "Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT";
const PR_AND_HEAD = "PR: acme/widgets#7\nHead: <full sha>";

describe("the compiled blocks", () => {
  it.each(RETURN_CONTRACTS)(
    "hold a %s block that is whole, generic and under the size cap",
    (contract) => {
      const text = RETURN_CONTRACT_BLOCKS[contract];

      expect(text).toContain("<spawner>");
      expect(carriesContract(text, contract)).toBe(true);
      expect(text.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
      expect(text).not.toMatch(
        /\/Users\/\w|@\w+\.\w+|[0-9a-f]{40}|npm ci|agent-chat,/
      );
    }
  );

  it.each(RETURN_CONTRACTS)(
    "tell a %s never to end a turn on a background task or a sleep",
    (contract) => {
      expect(flat(RETURN_CONTRACT_BLOCKS[contract])).toContain(
        "Never end a turn on a background task, a sleep or a ScheduleWakeup"
      );
    }
  );
});

describe("the GitHub write path (CC-456)", () => {
  it("names gh-write as the only write path, with no fallback to plain gh", () => {
    const text = flat(RETURN_CONTRACT_BLOCKS.implementer);

    expect(text).toContain(
      "`agent-chat gh-write -- <gh args> --body-file - <<'EOF'`"
    );
    expect(text).toContain("gh-write is the only write path");
    expect(text).not.toContain("otherwise use plain `gh`");
  });
});

describe("the PATH shim rule (CC-647)", () => {
  const SHIM_RULE =
    "Never put a shim named gh, git, node, npm or pnpm on PATH unless it drops its own dir from PATH " +
    "first (pattern: src/gh-shim/install.ts).";

  // Mutation caught: dropping SHIM_RULE from IMPLEMENTER_RULES or from the reviewer block.
  it.each([
    ["an implementer with a Shepherd handoff", "add the parser"],
    [
      "an implementer that waits on its own CI",
      `${SHEPHERD_NONE_MARKER}\nadd the parser`,
    ],
    ["a reviewer", "review PR 7"],
  ])("reaches %s in the spawned brief", async (_, brief) => {
    const profile = brief.startsWith("review") ? "reviewer" : "implementer";

    const { text } = await delivered({ brief, profile });

    expect(occurrences(text, SHIM_RULE)).toBe(1);
  });

  it("sits in both implementer variants", () => {
    expect(flat(RETURN_CONTRACT_BLOCKS.implementer)).toContain(SHIM_RULE);
    expect(flat(IMPLEMENTER_WITHOUT_SHEPHERD)).toContain(SHIM_RULE);
  });
});

describe("the check-run rule (CC-357)", () => {
  // Mutation caught: reverting the implementer CI line to a bare "then CI status".
  it('has the implementer paste each check-run at the head instead of reporting "green"', () => {
    const text = flat(RETURN_CONTRACT_BLOCKS.implementer);

    expect(text).toContain(
      "CI: <paste of: gh pr checks <n> --repo <owner>/<repo>>"
    );
    expect(text).toContain('never "green" alone');
    expect(text).toContain("`gh run watch` covers only one workflow");
    expect(text).toContain("a skipped check (std / compat) is no failure");
    expect(text).toContain(
      '"required" means the required contexts on the default branch'
    );
    expect(text).toContain("as it stands at the push (you do not wait for CI)");
  });

  // Mutation caught: dropping the reviewer's check-run line.
  it("has a reviewer without Shepherd confirm every required check-run at the head before a MERGE", () => {
    const text = flat(REVIEWER_WITHOUT_SHEPHERD);

    expect(text).toContain(
      "Before MERGE, confirm every required check-run (one branch protection names)"
    );
    expect(text).toContain(
      "`gh pr checks <n> --repo <owner>/<repo> --required`"
    );
    expect(text).toContain("FIX_FIRST if a required one failed");
    expect(text).toContain("A skipped check (std / compat) is not a failure");
  });
});

describe("the repo visibility the spawner states (CC-1384)", () => {
  // Mutation caught: the visibility never reaching the contract.
  it("tells an implementer the visibility it read at spawn, in place of a gh api probe", async () => {
    const { text } = await delivered({ visibility: "public" });

    expect(text).toContain(
      "Repo visibility, read at spawn: PUBLIC. If public, no real data"
    );
    expect(text).not.toContain("<repo visibility>");
    expect(text).not.toContain("--jq .visibility");
  });

  // Mutation caught: an unread visibility dropping the line instead of saying "treat it as public".
  it("tells the implementer to treat the repo as public when the read failed", async () => {
    const { text } = await delivered({ visibility: "unknown" });

    expect(text).toContain(
      "Repo visibility unread at spawn: treat it as public. If public, no real data"
    );
  });

  it("says the same when the spawner has no reader at all", async () => {
    const { text } = await delivered();

    expect(text).toContain("treat it as public");
  });

  it("states no visibility in a reviewer block", async () => {
    const { text } = await delivered({
      profile: "reviewer",
      visibility: "private",
    });

    expect(text).not.toContain("Repo visibility");
  });
});

describe("the reviewer CI rule (CC-1278)", () => {
  const text = flat(RETURN_CONTRACT_BLOCKS.reviewer);

  // Mutation caught: leaving `or WAIT` in the default verdict line, or dropping the Shepherd CI sentence.
  it("hands CI to Shepherd and offers no WAIT by default", () => {
    expect(text).toContain("Verdict: MERGE (or FIX_FIRST)");
    expect(text).toContain("CI is Shepherd's");
    expect(text).toContain(
      "pending or unread checks are no verdict input, never WAIT"
    );
    expect(text.replace("never WAIT", "")).not.toMatch(/\bWAIT\b/);
    expect(text).not.toContain(
      "Before MERGE, confirm every required check-run"
    );
  });

  // Mutation caught: a rewrite that drops red CI as a blocker.
  it("still blocks on a required check that already failed", () => {
    expect(text).toContain(
      "FIX_FIRST (Class: ci-red) only if a required check-run already failed"
    );
  });

  // Mutation caught: deleting the old lines instead of moving them into the variant.
  it("keeps WAIT and the check-run confirmation in the Shepherd: none variant", () => {
    const variant = flat(REVIEWER_WITHOUT_SHEPHERD);

    expect(variant).toContain("(or FIX_FIRST or WAIT)");
    expect(variant).toContain(
      "WAIT only for a clean review whose required checks have not finished"
    );
    expect(variant).not.toContain("CI is Shepherd's");
  });

  it("keeps the variant whole, generic and under the size cap", () => {
    expect(REVIEWER_WITHOUT_SHEPHERD).toContain("<spawner>");
    expect(carriesContract(REVIEWER_WITHOUT_SHEPHERD, "reviewer")).toBe(true);
    expect(REVIEWER_WITHOUT_SHEPHERD.length).toBeLessThanOrEqual(
      MAX_BLOCK_CHARS
    );
    expect(REVIEWER_WITHOUT_SHEPHERD).not.toMatch(
      /\/Users\/\w|@\w+\.\w+|[0-9a-f]{40}|npm ci|agent-chat,/
    );
  });

  // Mutation caught: leaving blockFor implementer-only.
  it.each([SHEPHERD_NONE_MARKER, "- Shepherd: none"])(
    "hands a reviewer brief with the line %j the Shepherd: none variant",
    async (marker) => {
      const brief = `${marker}\nreview PR 7`;

      const { text } = await delivered({ profile: "reviewer", brief });

      expect(text).toBe(
        `${brief}\n\n${REVIEWER_WITHOUT_SHEPHERD.split("<spawner>").join(
          "coord"
        )}`
      );
    }
  );

  it("hands a reviewer brief without the marker the Shepherd block", async () => {
    const { text } = await delivered({
      profile: "reviewer",
      brief: "review PR 7",
    });

    expect(text).toBe(`review PR 7\n\n${block("reviewer")}`);
    expect(text).not.toContain("or WAIT");
  });
});

describe("the reviewer findings shape (CC-1079)", () => {
  const text = flat(RETURN_CONTRACT_BLOCKS.reviewer);

  // Mutation caught: deleting the Defect class sentence or renaming its label.
  it("asks every FIX_FIRST for a Defect class line after Class", () => {
    expect(text).toContain(
      "then one line `Defect class: <what the blocking items share;"
    );
    expect(text.indexOf("Defect class:")).toBeGreaterThan(
      text.indexOf("Class: defect|")
    );
  });

  // Mutation caught: dropping the `- not fixed:` form, leaving only `fixed`.
  it("asks every re-review for an Earlier findings checklist marking each item fixed or not fixed", () => {
    expect(text).toContain("On a re-review");
    expect(text).toContain(
      "`Earlier findings:` then one short line per earlier blocking item"
    );
    expect(text).toContain("`- fixed: <item>`");
    expect(text).toContain("`- not fixed: <item>`");
    expect(text).toContain("`Earlier findings: none found`");
  });
});

describe("the reviewer Follow-ups block (TP-2498)", () => {
  const text = flat(RETURN_CONTRACT_BLOCKS.reviewer);

  // Mutation caught: dropping "never blocks MERGE" or the one-line-per-task form.
  it("names an optional Follow-ups block, one title | done_when | severity line per task, that never blocks MERGE", () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer).toContain(FOLLOW_UPS_RULE);
    expect(text).toContain(
      "`Follow-ups:` then `- <title> | <done_when> | low|medium|high` per task"
    );
    expect(text).toContain("never blocks MERGE");
  });

  // Mutation caught: placing the block ahead of the blocking items.
  it("places the block after the blocking items", () => {
    expect(text.indexOf("Follow-ups:")).toBeGreaterThan(
      text.indexOf("Then blocking items before nits.")
    );
  });

  // Mutation caught: adding the rule to a shared line (NEVER_PARK, SHIM_RULE) instead of the reviewer block.
  it("leaves both implementer blocks without it", () => {
    expect(RETURN_CONTRACT_BLOCKS.implementer).not.toContain("Follow-ups:");
    expect(IMPLEMENTER_WITHOUT_SHEPHERD).not.toContain("Follow-ups:");
  });

  it("keeps the reviewer block within the size cap", () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer.length).toBeLessThanOrEqual(
      MAX_BLOCK_CHARS
    );
  });
});

describe("a spawn by a registered session", () => {
  it.each([
    ["implementer", "implementer"],
    ["zz-implementer", "implementer"],
    ["zz-implementer-lite", "implementer"],
    ["zz_implementer", "implementer"],
    ["declared-builder", "implementer"],
    ["reviewer", "reviewer"],
    ["zz-reviewer", "reviewer"],
  ] as const)(
    "hands a %s agent the %s block exactly once",
    async (profile, contract) => {
      const { text, warnings } = await delivered({ profile });

      expect(occurrences(text, block(contract))).toBe(1);
      expect(occurrences(text, MARKER[contract])).toBe(1);
      // Mutation caught: joining the brief and the block without a blank line.
      expect(text).toContain(`add the parser\n\n${block(contract)}`);
      expect(warnings.join(" ")).not.toMatch(/return contract/);
    }
  );

  // Mutation caught: appending for every profile hands these a block.
  it.each([
    "explorer",
    "planner",
    "peer",
    "researcher",
    "builder",
    "lead-implementer",
    "quiet-reviewer",
  ])("hands a %s agent no block", async (profile) => {
    const { text } = await delivered({ profile });

    expect(text).toContain("add the parser");
    for (const contract of RETURN_CONTRACTS)
      expect(text).not.toContain(MARKER[contract]);
  });

  // Mutation caught: leaving the placeholder unfilled.
  it.each(RETURN_CONTRACTS)(
    "names the spawner in the %s block",
    async (contract) => {
      const { text } = await delivered({
        profile: contract,
        requestedBy: "north-seat",
      });

      expect(text).not.toContain("<spawner>");
      expect(flat(text)).toContain("chat_send to north-seat");
    }
  );

  // Mutation caught: a string replacement expands `$&` to `<spawner>`.
  it("writes a spawner name holding a replacement pattern as plain text", async () => {
    const { text } = await delivered({ requestedBy: "co$&rd$'" });

    expect(text).toContain("chat_send to co$&rd$' starting with");
    expect(text).not.toContain("<spawner>");
  });

  it("hands a CLI spawn no block, since nobody registered is there to report to", async () => {
    const { text } = await delivered({ requestedBy: "human" });

    expect(text).not.toContain(MARKER.implementer);
  });

  it("hands a successor spawned with a predecessor the block, after its assignment", async () => {
    await delivered({ name: "first" });

    const { text } = await delivered({
      name: "second",
      brief: "address the review",
      predecessor: "first",
    });

    expect(occurrences(text, block("implementer"))).toBe(1);
    expect(text).toContain(`address the review\n\n${block("implementer")}`);
  });

  // Mutation caught: reading the block from a file at spawn time.
  it("reads no contract from disk, so a second spawn gets the text the first started with", async () => {
    const first = await delivered({ name: "first" });
    const reads = [
      vi.spyOn(fs, "readFileSync"),
      vi.spyOn(fs, "existsSync"),
      vi.spyOn(fs, "statSync"),
    ];

    const second = await delivered({ name: "second" });

    const paths = reads.flatMap((spy) =>
      spy.mock.calls.map((call) => String(call[0]))
    );
    expect(
      paths.filter((file) => /return-contract|[\\/]skills[\\/]/.test(file))
    ).toEqual([]);
    expect(second.text).toContain(block("implementer"));
    expect(occurrences(first.text, block("implementer"))).toBe(1);
    reads.forEach((spy) => spy.mockRestore());
  });
});

describe("a spawn that opts out with return_contract none", () => {
  it.each(RETURN_CONTRACTS)(
    "hands a %s agent only the caller’s brief",
    async (profile) => {
      const { text, warnings } = await delivered({
        profile,
        returnContract: "none",
      });

      expect(text).toContain("add the parser");
      expect(text).not.toContain(MARKER[profile]);
      expect(warnings.join(" ")).not.toMatch(/return contract/);
    }
  );
});

// Mutation caught: appending without the duplicate check makes each count 2.
describe("a brief that already carries the contract", () => {
  const PASTED: ReadonlyArray<readonly [ReturnContract, string, string]> = [
    ["implementer", "whole", block("implementer")],
    ["implementer", "in the older wording", OLDER_IMPLEMENTER_BLOCK],
    [
      "implementer",
      "with a lower-case last action",
      `your last action is chat_send: ${STATUS}\n${PR_AND_HEAD}`,
    ],
    [
      "implementer",
      "with spaces around the bars",
      `LAST action: Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT\n${PR_AND_HEAD}`,
    ],
    ["reviewer", "whole", block("reviewer")],
    ["reviewer", "in the older wording", OLDER_REVIEWER_BLOCK],
    [
      "reviewer",
      "as MERGE or FIX_FIRST",
      `Verdict: MERGE or FIX_FIRST\n${PR_AND_HEAD}`,
    ],
    [
      "reviewer",
      "as MERGE | FIX_FIRST",
      `Verdict: MERGE | FIX_FIRST\n${PR_AND_HEAD}`,
    ],
    [
      "reviewer",
      "with WAIT added",
      `Verdict: MERGE (or FIX_FIRST or WAIT)\n${PR_AND_HEAD}`,
    ],
  ];

  it.each(PASTED)(
    "does not hand a %s agent a second copy when it is pasted %s",
    async (profile, _how, pasted) => {
      const brief = `add the parser\n\n${pasted}`;

      const { text, warnings } = await delivered({ profile, brief });

      expect(text).toBe(brief);
      expect(warnings.join(" ")).toMatch(PASTED_WARNING);
    }
  );
});

/** Each brief lacks one of the lines the spawner's tooling parses, so the agent would have no usable contract. */
describe("a brief that only quotes part of the contract", () => {
  it.each([
    [
      "implementer",
      "only the Status line",
      `Reports start with \`${STATUS}\`.`,
    ],
    [
      "implementer",
      "no Status line",
      `Your LAST action must be chat_send to coord.\n${PR_AND_HEAD}`,
    ],
    [
      "implementer",
      "two of the four Status values",
      `LAST action: Status: DONE|BLOCKED\n${PR_AND_HEAD}`,
    ],
    ["implementer", "no last-action rule", `Report ${STATUS}\n${PR_AND_HEAD}`],
    ["implementer", "no PR line", `LAST action: ${STATUS}\nHead: <full sha>`],
    [
      "implementer",
      "no Head line",
      `LAST action: ${STATUS}\nPR: acme/widgets#7`,
    ],
    [
      "reviewer",
      "only the Verdict line",
      "Verdict: MERGE            (or FIX_FIRST)",
    ],
    ["reviewer", "no Verdict line", PR_AND_HEAD],
    [
      "reviewer",
      "a Verdict line with one value",
      `Verdict: MERGE\n${PR_AND_HEAD}`,
    ],
    [
      "reviewer",
      "no PR line",
      "Verdict: MERGE (or FIX_FIRST)\nHead: <full 40-hex head sha>",
    ],
    [
      "reviewer",
      "no Head line",
      "Verdict: MERGE (or FIX_FIRST)\nPR: acme/widgets#7",
    ],
  ] as const)(
    "still hands a %s agent the block when the brief has %s",
    async (profile, _what, quoted) => {
      const { text, warnings } = await delivered({
        profile,
        brief: `add the parser\n\n${quoted}`,
      });

      expect(occurrences(text, block(profile))).toBe(1);
      expect(warnings.join(" ")).not.toMatch(PASTED_WARNING);
    }
  );

  it("still appends the reviewer block when the brief quotes the whole implementer one", async () => {
    const { text } = await delivered({
      profile: "reviewer",
      brief: `check this:\n\n${block("implementer")}`,
    });

    expect(occurrences(text, block("reviewer"))).toBe(1);
  });
});

describe("a brief with a report format of its own", () => {
  // Mutation caught: dropping the warning leaves the caller unaware the agent holds two formats.
  it.each([
    ["reviewer", "Report `Verdict: APPROVE | CHANGES` first."],
    ["reviewer", "Verdict: REQUEST_CHANGES or APPROVE"],
    ["implementer", "End with:\nStatus: ok or failed"],
  ] as const)(
    "appends the %s block and warns that both are there",
    async (profile, own) => {
      const { text, warnings } = await delivered({
        profile,
        brief: `add the parser\n\n${own}`,
      });

      expect(occurrences(text, block(profile))).toBe(1);
      expect(warnings.join(" ")).toMatch(OWN_FORMAT_WARNING);
      expect(warnings.join(" ")).toContain('return_contract: "none"');
    }
  );

  it("does not warn about a brief that only mentions status in passing", async () => {
    const { warnings } = await delivered({
      brief: "fix the status: field and the HTTP Status codes",
    });

    expect(warnings.join(" ")).not.toMatch(OWN_FORMAT_WARNING);
  });
});

describe("which contract a profile takes", () => {
  const ONLY_READS = { allowedTools: ["Read", "Bash"] };
  const EDIT_TAKEN_AWAY = { ...WRITER, disallowedTools: ["Edit"] };

  it.each([
    ["preimplementer", WRITER],
    ["zz-implementer-reviewer", WRITER],
    ["zz-implementer", READER],
    ["zz-implementer", ONLY_READS],
    ["zz-implementer", EDIT_TAKEN_AWAY],
    ["zz-reviewer", WRITER],
  ])(
    "gives %s none, because its name and grants do not agree on one",
    (name, body) => {
      expect(contractOf(profile(name, body))).toBeUndefined();
    }
  );

  it.each([
    ["zz-reviewer", ONLY_READS],
    ["zz-reviewer", EDIT_TAKEN_AWAY],
    ["zz_reviewer", READER],
  ])(
    "gives %s the reviewer block when Edit is not granted or is taken away",
    (name, body) => {
      expect(contractOf(profile(name, body))).toBe("reviewer");
    }
  );

  it("takes the declared contract over the one its name suggests", () => {
    expect(
      contractOf(
        profile("zz-reviewer", { ...WRITER, returnContract: "implementer" })
      )
    ).toBe("implementer");
  });

  it("leaves a resumed or opted-out brief byte-identical", () => {
    const builtin = PROFILES.reviewer!;
    const base = { brief: "review it", profile: builtin, spawner: "coord" };

    expect(withReturnContract({ ...base, resumed: true })).toEqual({
      brief: "review it",
      warnings: [],
    });
    expect(
      withReturnContract({ ...base, resumed: false, requested: "none" })
    ).toEqual({
      brief: "review it",
      warnings: [],
    });
  });
});

describe("the Shepherd handoff (TP-468)", () => {
  // Mutation caught: restoring "Wait for CI with `gh run watch`" in the implementer block.
  it("ends the implementer at pushed and registers the PR with a kind", () => {
    const text = flat(RETURN_CONTRACT_BLOCKS.implementer);

    expect(text).toContain(
      "titan-factory shepherd register <owner>/<repo>#<n> --task <initiative>/<ID>"
    );
    expect(text).toContain("--kind <correctness|security|feature|refactor>");
    expect(text).toContain("never wait on CI");
    expect(text).not.toContain("gh run watch <id>");
    expect(text).toContain("Shepherd: refused <first stderr line>");
  });

  // Mutation caught: dropping the exit-69 line, so an implementer has no report for a Shepherd that is down (TP-245).
  it("maps exit 69 to Shepherd: down and leaves CI to the spawner", () => {
    const text = flat(RETURN_CONTRACT_BLOCKS.implementer);

    expect(text).toContain(
      "or `Shepherd: down` on exit 69 (do not wait for it). <spawner> watches CI."
    );
    expect(flat(IMPLEMENTER_WITHOUT_SHEPHERD)).not.toContain("Shepherd: down");
  });

  // Mutation caught: an unconditional register line, which implementers followed over a brief saying not to (CC-635).
  it("makes the implementer register only when its brief asks, and lets a brief saying not to win", () => {
    const text = flat(RETURN_CONTRACT_BLOCKS.implementer);
    const gate =
      "Only if the brief asks (one saying not to wins), run `titan-factory shepherd register";

    expect(text).toContain(gate);
    expect(text.split("titan-factory shepherd register")).toHaveLength(2);
    expect(text).not.toContain("Then run `titan-factory shepherd register");
  });

  it("leaves the reviewer block free of any Shepherd register line", () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer).not.toMatch(
      /shepherd register|Register with Shepherd/i
    );
  });

  // Mutation caught: any change to the three lines bin/premerge and Shepherd parse.
  it.each([
    [RETURN_CONTRACT_BLOCKS.reviewer, "(or FIX_FIRST)"],
    [REVIEWER_WITHOUT_SHEPHERD, "(or FIX_FIRST or WAIT)"],
  ])("pins the reviewer verdict block", (reviewer, verdicts) => {
    expect(reviewer).toContain(
      `exactly these three lines:\nVerdict: MERGE            ${verdicts}\nPR: <owner>/<repo>#<n>\nHead: <full 40-hex head sha>\n`
    );
  });
});

describe("a brief that opts out of Shepherd (CC-452)", () => {
  const REGISTER = "titan-factory shepherd register <owner>/<repo>#<n>";
  const CI_WAIT =
    "Wait for CI as the brief directs and report each check-run's conclusion at the final head";

  it("keeps the variant block whole, generic and under the size cap", () => {
    expect(IMPLEMENTER_WITHOUT_SHEPHERD).toContain("<spawner>");
    expect(carriesContract(IMPLEMENTER_WITHOUT_SHEPHERD, "implementer")).toBe(
      true
    );
    expect(IMPLEMENTER_WITHOUT_SHEPHERD.length).toBeLessThanOrEqual(
      MAX_BLOCK_CHARS
    );
  });

  const BARE = [SHEPHERD_NONE_MARKER, "shepherd: NONE", "   Shepherd: none\t"];
  const LIST_ITEMS = [
    "- Shepherd: none",
    "* Shepherd: none",
    "2. Shepherd: none",
  ];

  // Mutation caught: ignoring the marker hands the agent the register sentence again.
  it.each([...BARE, ...LIST_ITEMS])(
    "drops the register and no-wait text for the line %j",
    async (marker) => {
      const brief = `add the parser\n${marker}\nwait for CI with bin/ci-wait`;

      const { text } = await delivered({ brief });

      const appended = flat(text.slice(brief.length));
      expect(appended).not.toContain(REGISTER);
      expect(appended).not.toContain("never wait on CI");
      expect(appended).not.toContain("you do not wait for CI");
      expect(appended).toContain(
        "Do not run `titan-factory shepherd register`."
      );
      expect(appended).toContain(CI_WAIT);
      expect(appended).toContain("chat_send to coord");
    }
  );

  // Mutation caught: a substring test opts out a brief that only talks about the marker.
  it("keeps Shepherd for a brief that mentions the marker mid-sentence", async () => {
    const brief =
      "add the parser; a seat may write Shepherd: none in its brief";

    const { text } = await delivered({ brief });

    expect(text).toBe(`${brief}\n\n${block("implementer")}`);
  });

  // Mutation caught: stripping any leading text, not just one list marker, opts these out.
  it.each(["- note: Shepherd: none is for seats", "-Shepherd: none"])(
    "keeps Shepherd for the line %j",
    async (line) => {
      const brief = `add the parser\n${line}`;

      const { text } = await delivered({ brief });

      expect(text).toBe(`${brief}\n\n${block("implementer")}`);
    }
  );

  it("hands a brief without the marker the default block unchanged", async () => {
    const { text } = await delivered();

    expect(text).toBe(`add the parser\n\n${block("implementer")}`);
    expect(flat(text)).toContain(REGISTER);
  });

  it("hands a reviewer brief carrying the marker the reviewer variant once", async () => {
    const { text } = await delivered({
      profile: "reviewer",
      brief: `review it\n${SHEPHERD_NONE_MARKER}`,
    });

    expect(
      occurrences(
        text,
        REVIEWER_WITHOUT_SHEPHERD.split("<spawner>").join("coord")
      )
    ).toBe(1);
    expect(occurrences(text, MARKER.reviewer)).toBe(1);
  });

  it("does not double a brief that already pastes the contract and carries the marker", async () => {
    const brief = `add the parser\n${SHEPHERD_NONE_MARKER}\n\n${block(
      "implementer"
    )}`;

    const { text, warnings } = await delivered({ brief });

    expect(text).toBe(brief);
    expect(warnings.join(" ")).toMatch(PASTED_WARNING);
  });
});

describe("the load-test rule (CC-473)", () => {
  // Mutation caught: restoring the pkill -f line in either implementer block.
  it.each([
    ["default", RETURN_CONTRACT_BLOCKS.implementer],
    ["Shepherd: none", IMPLEMENTER_WITHOUT_SHEPHERD],
  ])(
    "in the %s block applies only to an asked-for load test and kills by recorded PID",
    (_which, text) => {
      expect(text).not.toContain("pkill");
      expect(flat(text)).toContain(
        "Load test only if the brief asks: kill only burner PIDs you recorded, not by name; `pgrep` shows none left."
      );
    }
  );
});

describe("the Concerns and Notes lines (CC-399)", () => {
  // Mutation caught: dropping the Concerns/Notes sentence, which let a DONE_WITH_CONCERNS carry only notes.
  it.each([
    ["default", RETURN_CONTRACT_BLOCKS.implementer],
    ["Shepherd: none", IMPLEMENTER_WITHOUT_SHEPHERD],
  ])(
    "in the %s block splits action-needed Concerns from Notes, within the cap",
    (_which, block) => {
      const text = flat(block);

      expect(text).toContain(
        "Then `Concerns:` (what <spawner> must act on, or none;"
      );
      expect(text).toContain("DONE_WITH_CONCERNS needs one)");
      expect(text).toContain("and `Notes:`, each at most 3 one-line items.");
      expect(block.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
    }
  );

  // CC-1591. Mutation caught: dropping the cap, which let each report re-send its PR body.
  it.each([
    ["default", RETURN_CONTRACT_BLOCKS.implementer],
    ["Shepherd: none", IMPLEMENTER_WITHOUT_SHEPHERD],
  ])(
    "in the %s block caps the report at ~10 lines with detail in the PR body",
    (_which, block) => {
      expect(flat(block)).toContain(
        "Keep the report to ~10 lines; detail goes in the PR body or the task note."
      );
    }
  );

  it("leaves the reviewer block without either line", () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer).not.toContain("Concerns:");
    expect(RETURN_CONTRACT_BLOCKS.reviewer).not.toContain("Notes:");
  });
});

describe("the optional Friction line (CC-1660)", () => {
  const FRICTION =
    "Friction: <one line: the biggest thing that slowed you (waits, denials, flaky tests, missing context), or none>";

  it.each([
    ["implementer", RETURN_CONTRACT_BLOCKS.implementer],
    ["implementer without Shepherd", IMPLEMENTER_WITHOUT_SHEPHERD],
    ["reviewer", RETURN_CONTRACT_BLOCKS.reviewer],
    ["reviewer without Shepherd", REVIEWER_WITHOUT_SHEPHERD],
  ])(
    "in the %s block names the Friction line as optional, within the cap",
    (_which, block) => {
      expect(flat(block)).toContain(FRICTION);
      expect(flat(block)).toContain("Optional last line:");
      expect(block.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
    }
  );
});

describe("PR body path (CC-444, CC-725)", () => {
  // Mutation caught: a shared `$TMPDIR/body.md` lets one agent publish another's stale body.
  it.each([
    ["implementer", RETURN_CONTRACT_BLOCKS.implementer],
    ["implementer without Shepherd", IMPLEMENTER_WITHOUT_SHEPHERD],
  ])(
    "tells the %s block to post a body file from its own worktree within the size cap",
    (_name, block) => {
      expect(block).toContain(BODY_FILE_RULE);
      expect(BODY_FILE_RULE).toContain("in your own worktree");
      expect(BODY_FILE_RULE).toContain("deleted after");
      expect(block).not.toContain("cat it before");
      expect(block.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
    }
  );

  it("gives the reviewer its body-file rule and the quoting rule", () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer).toContain(REVIEWER_BODY_FILE_RULE);
    expect(RETURN_CONTRACT_BLOCKS.reviewer).toContain(QUOTE_RULE);
    expect(RETURN_CONTRACT_BLOCKS.reviewer.length).toBeLessThanOrEqual(
      MAX_BLOCK_CHARS
    );
  });
});

describe("CC-311: reviewers run mutants on literal paths", () => {
  it("gives the reviewer the mutant rule within the size cap", () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer).toContain(MUTANT_RULE);
    expect(RETURN_CONTRACT_BLOCKS.reviewer.length).toBeLessThanOrEqual(
      MAX_BLOCK_CHARS
    );
  });

  // Mutation caught: trimming the rule to "use sed -i", which is the form that stalled with $S/<file>.
  it("names the literal-path edit, its restore, the tree and the forbidden write targets", () => {
    expect(MUTANT_RULE).toContain("sed -i.bak '<edit>' <literal path>");
    expect(MUTANT_RULE).toContain("git checkout -- <literal path>");
    expect(MUTANT_RULE).toContain("$TMPDIR/<your name>");
    expect(MUTANT_RULE).toContain("`$VAR`");
    expect(MUTANT_RULE).toContain("`$(...)`");
  });

  it("leaves the implementer blocks without it", () => {
    expect(RETURN_CONTRACT_BLOCKS.implementer).not.toContain(MUTANT_RULE);
    expect(IMPLEMENTER_WITHOUT_SHEPHERD).not.toContain(MUTANT_RULE);
  });
});

describe("CC-897: bodies and comments go to gh-write on stdin in one call", () => {
  // Mutation caught: restoring "write the file in one Bash call, post it in the next", the habit
  // that walked agents into the guard's writtenBody denial.
  it("pins the implementer and reviewer sentences", () => {
    expect(BODY_FILE_RULE).toBe(
      "Post a body or comment in one call: `agent-chat gh-write -- <gh args> --body-file - <<'EOF'`, text, " +
        "EOF, no file. pr-ready's <f>: a .md Write put in your own worktree, deleted after."
    );
    expect(REVIEWER_BODY_FILE_RULE).toBe(
      "If you post text, use one call: `agent-chat gh-write -- <gh args> --body-file - <<'EOF'`, text, " +
        "EOF; write no file, the tree is not yours."
    );
  });

  it.each([
    ["implementer", RETURN_CONTRACT_BLOCKS.implementer],
    ["implementer without Shepherd", IMPLEMENTER_WITHOUT_SHEPHERD],
    ["reviewer", RETURN_CONTRACT_BLOCKS.reviewer],
    ["reviewer without Shepherd", REVIEWER_WITHOUT_SHEPHERD],
  ])(
    "no longer teaches the %s block a write-then-post body file",
    (_name, block) => {
      expect(block).not.toContain("posted in the next");
      expect(block).not.toContain("made by Write or `<<'EOF'`");
      expect(block).not.toContain("--body-file <f>`,");
    }
  );
});

describe("CC-690: pr-ready, WAIT and the Class line", () => {
  it("has both implementer blocks run pr-ready with --title and --body-file and fix every FAIL before pr create", () => {
    for (const block of [
      RETURN_CONTRACT_BLOCKS.implementer,
      IMPLEMENTER_WITHOUT_SHEPHERD,
    ]) {
      const text = flat(block);
      expect(text).toContain("agent-chat pr-ready --title <t> --body-file <f>");
      expect(text).toContain("fix every FAIL");
      expect(text.indexOf("pr-ready")).toBeLessThan(
        text.indexOf("gh-write -- <gh args>")
      );
    }
  });

  it("lets a reviewer without Shepherd say WAIT only for a clean review whose required checks have not finished", () => {
    const text = flat(REVIEWER_WITHOUT_SHEPHERD);
    expect(text).toContain("Verdict: MERGE (or FIX_FIRST or WAIT)");
    expect(text).toContain(
      "WAIT only for a clean review whose required checks have not finished"
    );
  });

  it("asks for a Class line naming the first blocker on FIX_FIRST", () => {
    const text = flat(RETURN_CONTRACT_BLOCKS.reviewer);
    expect(text).toContain(
      "Class: defect|test|pr-text|leak|lint|rebase|ci-red|changeset"
    );
    expect(text).toMatch(/FIX_FIRST[^.]*Class:/);
  });

  // CC-713. Mutation caught: dropping PROBE_SANDBOX_RULE from the REVIEWER array.
  it("runs risky probes only in a scratch repo whose origin is a local bare repo", () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer).toContain(PROBE_SANDBOX_RULE);
    expect(PROBE_SANDBOX_RULE).toContain("local bare repo (git init --bare)");
  });

  it("stays under the cap with the reviewer under its own 1,200-character report limit named", () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer.length).toBeLessThanOrEqual(
      MAX_BLOCK_CHARS
    );
  });
});
