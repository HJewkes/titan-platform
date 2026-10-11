import { describe, expect, it } from "vitest";
import { mergeCopies, type MeterOptions, type TranscriptCopy } from "./meter.js";
import { TP1550_RULES } from "./rules-tp1550.js";
import { V3_RULES } from "./rules-v3.js";
import { coordDutyTableSchema, dutyTable } from "./table.js";
import { seatOf } from "./transcript.js";
import { outcomeOf, triggerOf } from "./turn-signals.js";

const LO = "2026-01-01T00:00:00.000Z";
const HI = "2026-01-02T00:00:00.000Z";
const MODEL = "claude-opus-5-5";
/** 50k output tokens on the 5.5 row ($20/M) cost exactly one dollar. */
const ONE_DOLLAR = { output_tokens: 50_000 };

type Tool = { name: string; input: Record<string, unknown> };

let minute = 0;
function nextTs(): string {
  return new Date(Date.parse(LO) + ++minute * 60_000).toISOString();
}

function user(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "user", timestamp: nextTs(), message: { role: "user", content: text }, ...extra });
}

function toolResult(): string {
  return JSON.stringify({ type: "user", timestamp: nextTs(), message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
}

function assistant(id: string, tools: Tool[] = [], options: { usage?: object; model?: string; ts?: string } = {}): string {
  const content = tools.length ? tools.map((tool) => ({ type: "tool_use", ...tool })) : [{ type: "text", text: "noted" }];
  const message = { id, model: options.model ?? MODEL, usage: options.usage ?? ONE_DOLLAR, content };
  return JSON.stringify({ type: "assistant", timestamp: options.ts ?? nextTs(), message });
}

const bash = (command: string): Tool => ({ name: "Bash", input: { command } });
const read = (path: string): Tool => ({ name: "Read", input: { file_path: path } });

function copy(lines: string[], overrides: Partial<TranscriptCopy> = {}): TranscriptCopy {
  return { seat: "alpha-coord", sessionId: "session-1", size: lines.length, lo: LO, lines, ...overrides };
}

function meter(copies: TranscriptCopy[], overrides: Partial<MeterOptions> = {}) {
  return mergeCopies(copies, { hi: HI, rules: V3_RULES, inherit: "nearest", ops: ["op-one"], owners: ["op-one", "owner"], ...overrides });
}

const duties = (lines: string[], overrides: Partial<MeterOptions> = {}) => meter([copy(lines)], overrides).calls.map((call) => call.duty);

describe("duty assignment", () => {
  it("gives a text-only call in a merge turn the merge duty", () => {
    const lines = [user("merge the green one"), assistant("m1", [bash("seat-merge alpha acme/widgets 12 abc")]), toolResult(), assistant("m2")];

    expect(duties(lines)).toEqual(["merge", "merge"]);
  });

  it("classifies a compound command by the first rule in the set's order", () => {
    const lines = () => [user("hold it then merge"), assistant("m1", [bash("titan-factory shepherd hold x; ./bin/merge 12")])];

    expect(duties(lines(), { rules: V3_RULES })).toEqual(["shepherd-handops"]);
    expect(duties(lines(), { rules: TP1550_RULES })).toEqual(["merge"]);
  });

  it("marks every call of a read-only heartbeat as a no-op, but a read-only boot as handoff", () => {
    const reads = () => [assistant("m1", [read("/work/notes.md")]), toolResult(), assistant("m2", [bash("git log -3")])];

    expect(duties([user("Heartbeat tick 12"), ...reads()])).toEqual(["noop:cron-heartbeat", "noop:cron-heartbeat"]);
    expect(duties([user("Run the autonomy charter for alpha-coord"), ...reads()])).toEqual(["handoff", "scope-verify"]);
  });

  it("gives an unclassified call the nearest earlier duty or the turn's dominant one, by mode", () => {
    const lines = () => [
      user("finish up"),
      assistant("m1", [bash("seat-merge alpha acme/widgets 3 abc")]),
      toolResult(),
      assistant("m2"),
      assistant("m3", [{ name: "Write", input: { file_path: "/work/report.md" } }], { usage: { output_tokens: 250_000 } }),
    ];

    expect(duties(lines(), { inherit: "nearest" })).toEqual(["merge", "merge", "seat-own-work"]);
    expect(duties(lines(), { inherit: "dominant" })).toEqual(["merge", "seat-own-work", "seat-own-work"]);
  });

  it("routes sends by recipient: owner prefixes, peer seats, reviewers, then agents", () => {
    const send = (to: string | string[]): Tool => ({ name: "mcp__chat__chat_send", input: { to, message: "x" } });
    const lines = [user("tell everyone"), assistant("m1", [send("owner-laptop")]), assistant("m2", [send(["beta-coord"])]), assistant("m3", [send("pr-12-review")]), assistant("m4", [send("impl-7")])];

    expect(duties(lines)).toEqual(["owner-comm", "peer-coord", "review-route", "dispatch-brief"]);
  });
});

describe("copies of one session", () => {
  const big = () => [user("first"), assistant("m1", [bash("gh pr merge 1")]), assistant("m2"), user("second"), assistant("m3", [bash("gh pr merge 2")])];
  const small = () => [user("first"), assistant("m1", [bash("gh pr merge 1")]), user("third"), assistant("m4", [bash("gh pr merge 3")])];

  it("prices each message once and counts only turns holding a new message, largest copy first", () => {
    const result = meter([copy(small(), { size: 10 }), copy(big(), { size: 99 })]);

    expect(result.calls.map((call) => call.usd)).toEqual([1, 1, 1, 1]);
    expect(result.turns).toHaveLength(3);
    expect(result.inputs).toMatchObject({ transcripts: 2, sessions: 1, dupCopies: 1 });
  });
});

describe("window and pricing", () => {
  it("keeps a call at lo and drops one at hi", () => {
    const lines = [user("tick"), assistant("at-lo", [bash("gh pr merge 1")], { ts: LO }), assistant("at-hi", [bash("gh pr merge 2")], { ts: HI })];

    expect(meter([copy(lines)]).calls.map((call) => call.ts)).toEqual([LO]);
  });

  it("reads a window bound with no offset as UTC", () => {
    const lines = [user("tick"), assistant("m1", [bash("gh pr merge 1")], { ts: "2026-01-01T18:00:00.000Z" })];

    expect(meter([copy(lines, { lo: "2026-01-01T18:00" })]).calls).toHaveLength(1);
  });

  it("drops synthetic messages and counts an unknown model as unpriced", () => {
    const lines = [user("go"), assistant("m1", [], { model: "<synthetic>" }), assistant("m2", [], { model: "mystery-model-9" })];

    const result = meter([copy(lines)]);

    expect(result.calls.map((call) => call.usd)).toEqual([0]);
    expect(result.inputs).toMatchObject({ unpriced: 1, unpricedModels: { "mystery-model-9": 1 } });
  });

  it("prices a cache write with no ttl split at the 5m rate unless told 1h", () => {
    const usage = { cache_creation_input_tokens: 1_000_000 };
    const lines = () => [user("go"), assistant("m1", [bash("gh pr merge 1")], { usage })];

    expect(meter([copy(lines())]).calls[0]?.usd).toBe(5);
    expect(meter([copy(lines())], { splitlessCacheWrite: "1h" }).calls[0]?.usd).toBe(8);
    expect(meter([copy(lines())]).inputs.splitlessCacheWrites).toBe(1);
  });
});

describe("triggerOf", () => {
  const ops = ["op-one"];
  it.each([
    ["<command-name>/clear</command-name>", null, "local-cmd"],
    ["Heartbeat tick 4", "scheduled", "cron-heartbeat"],
    ["Teleport: resume from handoff", null, "boot"],
    ["ok, you are now resumed on the new host", null, "boot"],
    ["<task-notification>done</task-notification>", null, "bg-task-notification"],
    ['<channel source="agent-chat" from="beta-coord" system="true">x</channel>', null, "agent-chat system msg"],
    ['<channel source="agent-chat" from="beta-coord">x</channel>', null, "peer-seat msg"],
    ['<channel source="agent-chat" from="op-one">x</channel>', null, "operator/ram relay"],
    ["op-one here: please pause", null, "operator/ram relay"],
    ['<channel source="agent-chat" from="impl-7">Status: DONE</channel>', null, "own-agent report"],
    ["check the queue", "scheduled", "one-shot-timer"],
    ["check the queue", null, "owner/direct"],
  ])("reads %j as %s", (text, origin, expected) => {
    expect(triggerOf(text, origin, ops)).toBe(expected);
  });
});

describe("outcomeOf", () => {
  it("takes the first outcome in priority order, whatever the tool order", () => {
    expect(outcomeOf([{ name: "Write", input: {} }, bash("seat-merge a b 1 c")])).toBe("merge");
  });

  it("is NO-OP for reads and polls", () => {
    expect(outcomeOf([read("/work/a.md"), bash("gh pr view 3")])).toBe("NO-OP");
  });
});

describe("seatOf", () => {
  const seats = ["alpha-coord", "beta-coord"];

  it("finds the seat in a boot prompt", () => {
    expect(seatOf([user("You boot as seat beta-coord today.")], seats)).toBe("beta-coord");
  });

  it("finds the seat in a chat_register call", () => {
    const register = assistant("m1", [{ name: "mcp__chat__chat_register", input: { name: "alpha-coord" } }]);

    expect(seatOf([user("hello"), register], seats)).toBe("alpha-coord");
  });

  it("stops at a sidechain record", () => {
    expect(seatOf([user("helping alpha-coord", { isSidechain: true }), user("as seat alpha-coord")], seats)).toBeNull();
  });

  it("ignores a seat outside the list", () => {
    expect(seatOf([user("as seat gamma-coord")], seats)).toBeNull();
  });
});

describe("dutyTable", () => {
  it("totals duties and triggers, with dollars per merged PR", () => {
    const lines = [user("Heartbeat tick 1"), assistant("m1", [read("/work/a.md")]), user("merge"), assistant("m2", [bash("gh pr merge 1")]), assistant("m3", [bash("gh pr merge 2")])];

    const table = dutyTable(meter([copy(lines)]), { window: { lo: LO, hi: HI }, seats: ["alpha-coord"], rules: "v3", mergedPrs: 2 });

    expect(coordDutyTableSchema.safeParse(table).success).toBe(true);
    expect(table.window.hours).toBe(24);
    expect(table.totals).toEqual({ calls: 3, usd: 3, turns: 2, mergedPrs: 2, usdPerPr: 1.5 });
    expect(table.duties[0]).toMatchObject({ duty: "merge", kind: "det", group: "merges", calls: 2, usd: 2, usdPerPr: 1, perSeat: { "alpha-coord": 2 } });
    expect(table.duties[1]).toMatchObject({ duty: "noop:cron-heartbeat", group: "no-op ticks" });
    expect(table.triggers).toContainEqual({ trigger: "cron-heartbeat", turns: 1, noop: 1, usd: 1 });
  });
});
