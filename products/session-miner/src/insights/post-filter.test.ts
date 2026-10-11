import { describe, expect, it } from "vitest";
import { patternId, postFilters } from "./post-filter.js";

describe("postFilters", () => {
  it.each([
    ["agent-chat agent ls --prefix dc- 2>&1 | grep -E '^dc-' | head -5", "agent-chat agent ls", "| grep -E | head"],
    ["active-work task list demo | grep -A15 \"TP-1\" | head -n 30", "active-work task list", "| grep -A | head"],
    ["gh pr checks 12 | grep -c pass", "gh pr checks", "| grep -c"],
    ["titan-factory shepherd status --json | python3 -c 'import json,sys; print(json.load(sys.stdin))'", "titan-factory shepherd status", "| python3 -c json"],
    ["gh api repos/o/r/pulls/3 --jq .head | jq -r '.sha' > /tmp/out", "gh api GET pulls", "| jq -r"],
    ["timeout 60 basement-suite demo \"$B\" --agent x -- --run a.test.ts | tail -4", "basement-suite", "| tail"],
    ["sqlite3 -readonly ~/.agent-chat/events.db 'select 1' | cut -d'|' -f1,2 | sort -u", "sqlite3 events.db", "| cut -d -f | sort -u"],
    ["ssh box basement-suite demo main | tail -n2", "basement-suite", "| tail"],
  ])("normalises %s", (command, head, pattern) => {
    expect(postFilters(command)).toMatchObject([{ head, pattern }]);
  });

  it("reads every pipeline of a compound command, in order", () => {
    const uses = postFilters("cd /tmp && gh pr view 1 --json body | head; agent-chat agent ls | wc -l");

    expect(uses.map((u) => [u.head, u.pattern])).toEqual([
      ["gh pr view", "| head"],
      ["agent-chat agent ls", "| wc -l"],
    ]);
  });

  it("ignores a pipeline headed by another program, one with no tail, and sqlite3 on a database that is not ours", () => {
    expect(postFilters("git log | head; gh pr view 1; sqlite3 other.db 'select 1' | head; cat x | gh pr comment 1")).toEqual([]);
  });

  it("names the help command, the head's own flags and each tail stage", () => {
    expect(postFilters("gh api repos/o/r/pulls --paginate -q .x | head -3")).toEqual([
      { head: "gh api GET pulls", helpArgv: ["gh", "api"], headFlags: ["--paginate", "-q"], pattern: "| head", stages: ["head"] },
    ]);
  });

  it("gives the same pattern whatever the operands, flag values or flag order", () => {
    const a = postFilters("agent-chat agent ls | grep -v -E 'retired|done' | head -20");
    const b = postFilters("agent-chat agent ls --prefix x | grep -Ev running | head -n 3");

    expect(a[0]?.pattern).toBe("| grep -E -v | head");
    expect(b[0]?.pattern).toBe(a[0]?.pattern);
  });
});

describe("patternId", () => {
  it("is a stable hash of the pattern, not a position", () => {
    expect(patternId("| head")).toBe(patternId("| head"));
    expect(patternId("| head")).toMatch(/^pf-[0-9a-f]{12}$/);
    expect(patternId("| head")).not.toBe(patternId("| tail"));
  });
});
