import { describe, expect, it } from "vitest";
import { classifyDeniedAction, parseDenials } from "./blocked-flow-denials.js";
import { TICK_HOLD_MAX_MIN, UNSTATED_REASON, idleSlotMinutes, parseSeatJournal } from "./blocked-flow-idle.js";
import { latencyStats, mergeOutcomes, parseVerdict, type PullState, type VerdictRecord } from "./blocked-flow-merge.js";
import { ALL_REPOS, blockedFlowReport, blockedFlowSchema, renderBlockedFlowText } from "./blocked-flow.js";
import { LIST_PRICE_CAVEAT } from "./render-text.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
let nextId = 1;

function verdict(repo: string, pr: number, at: string, head = HEAD_A, extra: Partial<VerdictRecord> = {}): VerdictRecord {
  return { eventId: nextId++, at, seat: "seat-a", reviewer: "rev-1", verdict: "MERGE", repo, pr, head, ...extra };
}

function pull(repo: string, pr: number, mergedAt: string | null, headSha = HEAD_A, state: "open" | "closed" = mergedAt ? "closed" : "open"): PullState {
  return { repo, pr, state, mergedAt, headSha };
}

const AS_OF = "2026-09-10T12:00:00.000Z";

describe("parseVerdict", () => {
  it("reads the verdict, PR and head lines of a reviewer message", () => {
    const body = `Verdict: MERGE\nPR: acme/widgets#12\nHead: ${HEAD_A}\n\nBlocking: none.`;

    expect(parseVerdict(body)).toEqual({ verdict: "MERGE", repo: "acme/widgets", pr: 12, head: HEAD_A });
  });

  it("refuses a short head, as the merge gate does", () => {
    expect(parseVerdict("Verdict: MERGE\nPR: acme/widgets#7\nHead: abc1234")).toBeNull();
  });

  it("refuses the PR URL form, which the gate parser does not read", () => {
    expect(parseVerdict(`Verdict: FIX_FIRST\nPR: https://github.com/acme/widgets/pull/7\nHead: ${HEAD_A}`)).toBeNull();
  });

  it("still reads a WAIT verdict so it is never taken for a MERGE", () => {
    expect(parseVerdict(`Verdict: WAIT\nPR: acme/widgets#7\nHead: ${HEAD_A}`)).toMatchObject({ verdict: "WAIT", pr: 7 });
  });

  it("returns null when the head line is missing", () => {
    expect(parseVerdict("Verdict: MERGE\nPR: acme/widgets#12")).toBeNull();
  });
});

describe("mergeOutcomes", () => {
  it("measures from the first MERGE at the final head, not an earlier head", () => {
    const verdicts = [verdict("acme/w", 1, "2026-09-10T08:00:00Z", HEAD_B), verdict("acme/w", 1, "2026-09-10T09:00:00Z"), verdict("acme/w", 1, "2026-09-10T09:30:00Z")];

    const [outcome] = mergeOutcomes(verdicts, [pull("acme/w", 1, "2026-09-10T09:45:00Z")], AS_OF);

    expect(outcome).toMatchObject({ status: "merged", minutes: 45 });
  });

  it("treats a PR merged after asOf as open, with its age as a censored wait", () => {
    const [outcome] = mergeOutcomes([verdict("acme/w", 2, "2026-09-10T11:00:00Z")], [pull("acme/w", 2, "2026-09-10T13:00:00Z")], AS_OF);

    expect(outcome).toMatchObject({ status: "open", minutes: 60 });
  });

  it("never counts a WAIT verdict as a MERGE, even at the final head of a merged PR", () => {
    const wait = verdict("acme/w", 9, "2026-09-10T09:00:00Z", HEAD_A, { verdict: "WAIT" });

    expect(mergeOutcomes([wait], [pull("acme/w", 9, "2026-09-10T09:45:00Z")], AS_OF)).toEqual([]);
  });

  it("measures from the MERGE, not an earlier WAIT at the same head", () => {
    const verdicts = [verdict("acme/w", 9, "2026-09-10T09:00:00Z", HEAD_A, { verdict: "WAIT" }), verdict("acme/w", 9, "2026-09-10T09:30:00Z")];

    const [outcome] = mergeOutcomes(verdicts, [pull("acme/w", 9, "2026-09-10T09:45:00Z")], AS_OF);

    expect(outcome).toMatchObject({ status: "merged", minutes: 15 });
  });

  it.each([
    ["stale-head", pull("acme/w", 3, null, HEAD_B)],
    ["closed", pull("acme/w", 3, null, HEAD_A, "closed")],
    ["unknown", undefined],
  ])("labels a PR %s and gives it no wait", (status, state) => {
    const [outcome] = mergeOutcomes([verdict("acme/w", 3, "2026-09-10T10:00:00Z")], state ? [state] : [], AS_OF);

    expect(outcome).toMatchObject({ status, minutes: null });
  });

  it("ignores FIX_FIRST verdicts", () => {
    expect(mergeOutcomes([verdict("acme/w", 4, "2026-09-10T10:00:00Z", HEAD_A, { verdict: "FIX_FIRST" })], [pull("acme/w", 4, null)], AS_OF)).toEqual([]);
  });
});

describe("latencyStats", () => {
  it("reports merged waits and keeps open ages apart as a lower bound", () => {
    const outcomes = [1, 2, 3, 10].map((m, i) => ({ repo: "r", pr: i, status: "merged" as const, verdict: null, minutes: m }));
    const open = { repo: "r", pr: 9, status: "open" as const, verdict: null, minutes: 100 };

    expect(latencyStats([...outcomes, open])).toEqual({
      merged: 4, medianMin: 2.5, meanMin: 4, p90Min: 10, maxMin: 10,
      censored: 1, oldestCensoredMin: 100, censoredPrMinutes: 100, medianWithCensoredMin: 3,
    });
  });
});

describe("parseDenials", () => {
  const call = (id: string, name: string, input: unknown) => JSON.stringify({ timestamp: "2026-09-10T10:00:00Z", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string, text: string) =>
    JSON.stringify({ timestamp: "2026-09-10T10:00:05Z", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] } });
  const denied = (reason: string) => `Permission for this action was denied by the Claude Code auto mode classifier. Reason: [${reason}]. If you have other tasks...`;

  it("joins each refusal to the call it refused and classifies the action", () => {
    const lines = [
      call("t1", "Bash", { command: "gh api -X PUT repos/acme/w/pulls/3/merge" }),
      result("t1", denied("Merge Without Review")),
      call("t2", "Bash", { command: "git push origin --delete feat/x" }),
      result("t2", denied("Merge Without Review")),
      call("t3", "Edit", { file_path: "/tmp/demo/queue.md" }),
      result("t3", "ok"),
    ];

    expect(parseDenials(lines, "seat-a")).toEqual([
      { seat: "seat-a", at: "2026-09-10T10:00:05Z", reason: "Merge Without Review", action: "merge", tool: "Bash", toolUseId: "t1" },
      { seat: "seat-a", at: "2026-09-10T10:00:05Z", reason: "Merge Without Review", action: "branch-delete", tool: "Bash", toolUseId: "t2" },
    ]);
  });

  it("does not count a tool result that only quotes the refusal text", () => {
    const lines = [call("t1", "Bash", { command: "grep classifier log" }), result("t1", `log.md:3: ${denied("Git Destructive")}`)];

    expect(parseDenials(lines, "seat-a")).toEqual([]);
  });

  it.each([
    ["Bash", { command: "agent-chat agent retire demo-1" }, "retire"],
    ["Bash", { command: "git worktree remove .worktrees/x" }, "worktree-remove"],
    ["Bash", { command: "ls 2>&1 >/dev/null" }, "bash-other"],
    ["Bash", { command: "cat >> notes/queue.md <<EOF" }, "file-write"],
    ["Bash", { command: "python3 - <<'EOF'\ns=open(p,'w')" }, "file-write"],
    ["Bash", { command: "agent-chat service restart" }, "service-restart"],
    ["Bash", { command: "gh api -X DELETE repos/acme/w/git/refs/heads/feat/x" }, "branch-delete"],
    ["Write", { file_path: "x" }, "file-edit"],
    ["mcp__plugin_demo__agent_retire", {}, "mcp:agent_retire"],
  ])("classifies %s %j as %s", (tool, input, action) => {
    expect(classifyDeniedAction(tool, input)).toBe(action);
  });
});

describe("idle implementer slots", () => {
  const journal = [
    "# seat-a 2026-09-10",
    "",
    "06:00 tick: impl 3/3, rev 1/1.",
    "06:30 tick: impl 1/3, rev 0/1. No dispatch: worktree caps full for every repo; rest gated",
    "06:50:30 verdict acme/w#1 MERGE. impl 2/3",
    "07:00 tick: impl 2/3",
    "09:00 done",
  ].join("\n");

  it("reads local journal times through the offset and the stated reason", () => {
    const { ticks, lastAt } = parseSeatJournal(journal, "seat-a", "2026-09-10", -360);

    expect(ticks.map((t) => [t.at, t.used, t.cap, t.reason, t.line])).toEqual([
      ["2026-09-10T12:00:00.000Z", 3, 3, "", 3],
      ["2026-09-10T12:30:00.000Z", 1, 3, "worktree caps full for every repo", 4],
      ["2026-09-10T12:50:30.000Z", 2, 3, UNSTATED_REASON, 5],
      ["2026-09-10T13:00:00.000Z", 2, 3, UNSTATED_REASON, 6],
    ]);
    expect(lastAt).toBe("2026-09-10T15:00:00.000Z");
  });

  it("multiplies free slots by the minutes each count held, capped per tick", () => {
    const rows = idleSlotMinutes([parseSeatJournal(journal, "seat-a", "2026-09-10", -360)], {});

    expect(rows).toEqual([
      { seat: "seat-a", reason: UNSTATED_REASON, slotMinutes: Math.round(9.5 + TICK_HOLD_MAX_MIN), ticks: 2, lines: [5, 6] },
      { seat: "seat-a", reason: "worktree caps full for every repo", slotMinutes: 41, ticks: 1, lines: [4] },
    ]);
  });

  it("clips held minutes to the window", () => {
    const rows = idleSlotMinutes([parseSeatJournal(journal, "seat-a", "2026-09-10", -360)], { until: "2026-09-10T12:40:00.000Z" });

    expect(rows).toEqual([{ seat: "seat-a", reason: "worktree caps full for every repo", slotMinutes: 20, ticks: 1, lines: [4] }]);
  });
});

describe("blockedFlowReport", () => {
  const verdicts = [
    verdict("acme/w", 1, "2026-09-10T08:00:00Z"),
    verdict("acme/w", 2, "2026-09-10T10:00:00Z"),
    verdict("acme/g", 3, "2026-09-10T10:30:00Z"),
    verdict("acme/g", 4, "2026-09-10T11:00:00Z", HEAD_A, { seat: "seat-b" }),
  ];
  const pulls = [pull("acme/w", 1, "2026-09-10T09:30:00Z"), pull("acme/w", 2, "2026-09-10T10:01:00Z"), pull("acme/g", 3, null), pull("acme/g", 4, null)];

  it("splits verdict-to-merge at a grant and lists PRs still holding MERGE", () => {
    const report = blockedFlowReport({ verdicts, pulls, denials: [], journals: [], asOf: AS_OF, splitAt: "2026-09-10T09:00:00Z", seats: ["seat-a"] });
    const all = report.verdictToMerge.rows.find((r) => r.repo === ALL_REPOS)!;

    expect(blockedFlowSchema.safeParse(report).success).toBe(true);
    expect([all.before!.medianMin, all.after!.medianMin, all.after!.censored]).toEqual([90, 1, 1]);
    expect(report.openHoldingMerge.rows).toMatchObject([{ repo: "acme/g", pr: 3, ageMin: 90 }]);
  });

  it("counts a MERGE with a 7-char head as refused and never as holding MERGE", () => {
    const short = verdict("acme/g", 3, "2026-09-10T10:30:00Z", HEAD_A.slice(0, 7));
    const report = blockedFlowReport({ verdicts: [short], unparsedVerdicts: 2, pulls: [pull("acme/g", 3, null)], denials: [], journals: [], asOf: AS_OF });

    expect(report.openHoldingMerge.rows).toEqual([]);
    expect(report.verdictToMerge.rows.find((r) => r.repo === ALL_REPOS)!.prs).toBe(0);
    expect(report.refusedVerdicts.count).toBe(3);
    expect(blockedFlowSchema.safeParse(report).success).toBe(true);
  });

  it("counts a refusal repeated by a forked transcript once", () => {
    const denial = (toolUseId: string, seat = "seat-a") => ({ seat, at: "2026-09-10T10:00:00Z", reason: "Merge Without Review", action: "merge", tool: "Bash", toolUseId });
    const report = blockedFlowReport({ verdicts: [], pulls: [], denials: [denial("t1"), denial("t1"), denial("t2"), denial("t1", "seat-b")], journals: [], asOf: AS_OF });

    expect(report.denials.total).toBe(3);
    expect(report.denials.rows.map((r) => [r.seat, r.count])).toEqual([["seat-a", 2], ["seat-b", 1]]);
  });

  it("counts denials by reason, action and seat inside the window", () => {
    const denial = (at: string, seat = "seat-a") => ({ seat, at, reason: "Merge Without Review", action: "merge", tool: "Bash" });
    const report = blockedFlowReport({ verdicts: [], pulls: [], denials: [denial("2026-09-10T10:00:00Z"), denial("2026-09-10T11:00:00Z"), denial("2026-09-09T10:00:00Z"), denial("2026-09-10T10:00:00Z", "seat-b")], journals: [], asOf: AS_OF, window: { since: "2026-09-10" } });

    expect(report.denials.rows).toEqual([
      { reason: "Merge Without Review", action: "merge", seat: "seat-a", count: 2 },
      { reason: "Merge Without Review", action: "merge", seat: "seat-b", count: 1 },
    ]);
  });

  it("renders every table with the JSON field it cites, the sources and the caveat last", () => {
    const text = renderBlockedFlowText(blockedFlowReport({ verdicts, pulls, denials: [], journals: [], asOf: AS_OF, splitAt: "2026-09-10T09:00:00Z" }));

    for (const field of ["verdictToMerge.rows[].all", "verdictToMerge.rows[].before", "openHoldingMerge.rows[].ageMin", "denials.rows[].count", "idleSlots.rows[].slotMinutes"]) expect(text).toContain(`[${field}]`);
    expect(text).toContain("gh api repos/<owner>/<repo>/pulls/<n>");
    expect(text.trimEnd().endsWith(LIST_PRICE_CAVEAT)).toBe(true);
  });
});
