/**
 * A synthetic operator session that ended mid-work with no wrap. Every name, path, task id
 * and message is invented; it only mirrors the shape of a real Claude Code transcript.
 */

export const RECOVERY_SESSION = "0f9c2a5e-recovery-fixture";
export const RECOVERY_ROOT = "/work/demo-platform";
const CWD = RECOVERY_ROOT;

const CHAT = "mcp__plugin_agent-chat_agent-chat__";
export const LONG_REPLY = `Merged the parser fix. ${"Next I will rerun the flaky suite. ".repeat(80)}`;
export const SECRET_ARG = "ghp_fixtureTokenNotReal";

type Row = Record<string, unknown>;

function row(ts: string, fields: Row): Row {
  return { sessionId: RECOVERY_SESSION, cwd: CWD, gitBranch: "main", timestamp: ts, uuid: `u-${ts}`, ...fields };
}

function owner(ts: string, content: unknown): Row {
  return row(ts, { type: "user", message: { role: "user", content } });
}

function assistant(ts: string, content: unknown[]): Row {
  return row(ts, { type: "assistant", message: { role: "assistant", id: `m-${ts}`, model: "claude-test", content } });
}

function tool(ts: string, id: string, name: string, input: Row): Row {
  return assistant(ts, [{ type: "tool_use", id, name, input }]);
}

function result(ts: string, id: string, content: string): Row {
  return owner(ts, [{ type: "tool_result", tool_use_id: id, content }]);
}

const at = (minute: number): string => `2026-03-04T09:${String(minute).padStart(2, "0")}:00Z`;

const RECOVERY_RECORDS: readonly Row[] = [
  owner(at(0), "Morning. Pick up the demo board and register as ops-lead."),
  tool(at(1), "t1", `${CHAT}chat_register`, { name: "ops-lead", summary: "operator for the demo board" }),
  result(at(1), "t1", "registered"),
  owner(at(2), "<system-reminder>Context reminder injected by the harness.</system-reminder>"),
  tool(at(3), "t2", "Bash", { command: "active-work task add demo \"Fix the flaky parser\" --priority 1" }),
  tool(at(4), "t3", "Bash", { command: "cd /work/demo-platform && git status && git log --oneline -5" }),
  owner(at(5), "Spawn a worker for DM-12 and tell the reviewer."),
  tool(at(6), "t4", `${CHAT}agent_spawn`, { name: "dm-12-worker", brief: "\nImplement DM-12: fix the flaky parser.\nRun tests." }),
  tool(at(7), "t5", `${CHAT}chat_send`, { to: "demo-reviewer", text: "Heads up: DM-12 is in flight.\nPR soon." }),
  owner(at(8), "<channel source=\"plugin:agent-chat:agent-chat\" from=\"dm-12-worker\" msg_id=\"x1\">Status: DONE</channel>"),
  owner(at(9), "Good. Merge it once checks pass."),
  tool(at(10), "t6", "Bash", { command: `gh pr merge 7 --squash && GH_TOKEN=${SECRET_ARG} gh api repos/acme/demo/pulls/7?per_page=1` }),
  tool(at(11), "t7", "Write", { file_path: `${RECOVERY_ROOT}/notes/handoff.md`, content: "draft" }),
  tool(at(12), "t8", "Edit", { file_path: "/tmp/elsewhere/scratch.md", old_string: "a", new_string: "b" }),
  tool(at(13), "t9", "Bash", { command: "active-work task done demo DM-12 && active-work note add demo \"parser fixed\"" }),
  tool(at(14), "t10", "Bash", { command: "active-work task done demo DM-13" }),
  owner(at(15), "Also close the loop on the release note."),
  owner(at(16), "And check the nightly run."),
  owner(at(17), "Last thing: post the summary."),
  assistant(at(18), [{ type: "text", text: LONG_REPLY }]),
];

export function recoveryTranscript(): string {
  return RECOVERY_RECORDS.map(record => JSON.stringify(record)).join("\n") + "\n";
}
