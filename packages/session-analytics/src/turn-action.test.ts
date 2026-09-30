import { describe, expect, it } from "vitest";
import { DEFAULT_ACTION_RULES, classifyRequest, type ActionCall, type ActionClass } from "./turn-action.js";

const bash = (...heads: string[]): ActionCall => ({ tool: "Bash", heads });

/** One call per default rule, in rule order, each matching its own rule. */
const RULE_SAMPLES: ActionCall[] = [
  { tool: "Write", writePaths: ["notes/session-log.md"] },
  bash(">events.jsonl"),
  bash("gh pr checks"),
  bash("gh run watch"),
  bash("gh pr merge"),
  { tool: "mcp__srv__agent_spawn" },
  bash("agent-chat agent retire"),
  bash("active-work task edit"),
  { tool: "mcp__srv__session_budget" },
  bash("agent-chat agent list"),
  { tool: "mcp__srv__score_turn" },
  bash("python scorer"),
  { tool: "mcp__srv__chat_send" },
  { tool: "Read", readPaths: ["src/a.ts"] },
  bash("git log"),
];

const ADJACENT_PAIRS = DEFAULT_ACTION_RULES.slice(0, -1)
  .map((rule, i) => ({ i, higher: rule.cls, lower: DEFAULT_ACTION_RULES[i + 1]!.cls }))
  .filter(({ higher, lower }) => higher !== lower);

describe("classifyRequest", () => {
  it("has one sample per default rule and each sample matches its rule", () => {
    expect(RULE_SAMPLES).toHaveLength(DEFAULT_ACTION_RULES.length);
    DEFAULT_ACTION_RULES.forEach((rule, i) => expect(classifyRequest([RULE_SAMPLES[i]!], [rule])).toBe(rule.cls));
  });

  it.each(DEFAULT_ACTION_RULES.map((rule, i) => [rule.cls, i] as const))("classifies a synthetic %s request (rule %i)", (cls, i) => {
    expect(classifyRequest([RULE_SAMPLES[i]!])).toBe(cls);
  });

  it.each(ADJACENT_PAIRS)("rule $i ($higher) outranks the next rule ($lower) whatever the call order", ({ i, higher }) => {
    expect(classifyRequest([RULE_SAMPLES[i + 1]!, RULE_SAMPLES[i]!])).toBe(higher);
  });

  it("classifies the pulls merge API as merge", () => {
    expect(classifyRequest([bash("gh api repos/o/r/pulls/5/merge")])).toBe("merge");
  });

  it("classifies a request with no calls as text-only", () => {
    expect(classifyRequest([])).toBe("text-only");
  });

  it("classifies an unknown MCP tool as other", () => {
    expect(classifyRequest([{ tool: "mcp__srv__frobnicate" }])).toBe("other");
  });

  it("uses caller-supplied rules instead of the defaults", () => {
    expect(classifyRequest([bash("deploy")], [{ cls: "merge", head: /^deploy/ }])).toBe("merge");
  });
});

describe("default rules match a command only in its program position", () => {
  const cases: [string, string, ActionClass][] = [
    ["echo that names a merge URL", "echo pulls/5/merge", "other"],
    ["grep for a retire command", "grep agent retire", "read-investigate"],
    ["echo of an agent list command", "echo agent list", "other"],
    ["cat of a score source file", "cat src/score.ts", "read-investigate"],
    ["a scorer script run directly", "score.sh", "scorer"],
    ["the agent retire alias", "agent retire", "retire"],
  ];

  it.each(cases)("%s", (_name, head, cls) => {
    expect(classifyRequest([bash(head)])).toBe(cls);
  });
});

describe("journal writes match on the file's basename", () => {
  const journal = ["notes/session-log.md", "log.md", "dev/work_journal.txt", "run/events.jsonl", "a/log.jsonl"];
  const notJournal = ["docs/catalog.md", "CHANGELOG.md", "test/fixtures/sample.jsonl", "logs/readme.md", "src/log.ts"];

  it.each(journal)("%s is a journal write", (file) => {
    expect(classifyRequest([{ tool: "Write", writePaths: [file] }])).toBe("journal-write");
  });

  it.each(notJournal)("%s is not a journal write", (file) => {
    expect(classifyRequest([{ tool: "Write", writePaths: [file] }])).toBe("other");
  });

  it("applies the same basename rule to redirect targets", () => {
    expect(classifyRequest([bash(">CHANGELOG.md")])).toBe("other");
    expect(classifyRequest([bash(">session-log.md")])).toBe("journal-write");
  });
});
