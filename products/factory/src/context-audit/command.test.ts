import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";

const MODEL = "claude-opus-5";
const usage = (input: number, cw: number, cr: number, out: number) => ({ input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out });
const snapshot = (at: string, blocks: string[], tools: string[]) => ({ type: "attachment", timestamp: at, attachment: { type: "prompt_snapshot", systemPrompt: blocks, tools: tools.map((name) => ({ name, description: "d", schema: {} })) } });
const assistant = (id: string, u: object | undefined, content: object[] = []) => ({ type: "assistant", timestamp: "2026-10-20T10:00:00Z", message: { id, model: MODEL, usage: u, content } });

const IMPLEMENTER = [
  { type: "agent-name", agentName: "impl-1" },
  { type: "attachment", attachment: { type: "instructions", files: [{ path: "/work/proj/CLAUDE.md", type: "Project", content: "x".repeat(300) }] } },
  snapshot("2026-10-20T09:00:00Z", ["base prompt"], ["Bash"]),
  snapshot("2026-10-20T09:30:00Z", ["base prompt", "You are a spawned agent. Rule marker A."], ["Bash", "Read"]),
  assistant("m1", usage(10, 1000, 0, 100), [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "CI=1 pnpm test --run" } }]),
  assistant("m1", usage(10, 1000, 0, 100)),
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "y".repeat(50) }] } },
  assistant("m2", usage(5, 50, 1000, 20)),
  "not json",
  assistant("m3", usage(0, 0, 1100, 5)),
];
const REVIEWER = [{ type: "agent-name", agentName: "rv-pr-9" }, snapshot("2026-10-21T09:00:00Z", ["base prompt", "You review."], ["Read"]), assistant("r1", usage(1, 2000, 0, 10))];
const OLD_COORDINATOR = [{ type: "agent-name", agentName: "ws-coord" }, snapshot("2026-09-01T09:00:00Z", ["Rule marker A."], []), assistant("c1", usage(1, 1, 1, 1))];

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const MONTH_AGO = new Date(Date.now() - 30 * 86_400_000).toISOString();
const channel = (from: string, body: string, attrs = "") => `<channel source="plugin:agent-chat:agent-chat" from="${from}" msg_id="x"${attrs}>\n${body}\n</channel>`;
const pushed = (content: unknown, fields: object = {}, at = HOUR_AGO) => ({ type: "user", timestamp: at, message: { role: "user", content }, ...fields });
const fromPeer = (body: string) => pushed(body, { origin: { kind: "channel" }, turnOrigin: "peer", isMeta: true });
const queued = (kind: string, prompt: string) => ({ type: "attachment", timestamp: HOUR_AGO, attachment: { type: "queued_command", origin: { kind }, prompt, timestamp: HOUR_AGO } });

const COORDINATOR_GEN_1 = [{ type: "agent-name", agentName: "ws-coord" }, pushed("You are ws-coord gen 1.", { turnOrigin: "sdk" }), assistant("g1", usage(1, 1, 1, 1))];
const COORDINATOR_GEN_2 = [
  { type: "agent-name", agentName: "ws-coord" },
  fromPeer(channel("human", "Shepherd digest for ws-coord: 2 open, 1 finished")),
  fromPeer(channel("human", "Shepherd: acme/widgets#7 gated on review")),
  fromPeer(channel("human", "deploy alarm: a deploy has not landed")),
  fromPeer(channel("agent-chat", "Lifecycle: w1 attached", ' system="true" count="1"')),
  fromPeer(channel("agent-chat", "w2 exited with no Status report")),
  fromPeer(channel("agent-chat", "2 reports from peers (w1, w2), delivered together", ' count="2" senders="w1,w2"')),
  fromPeer(channel("w1", "Status: DONE")),
  pushed("<task-notification>\n<summary>Monitor event</summary>\n</task-notification>", { origin: { kind: "task-notification" }, turnOrigin: "task_notification" }),
  pushed("Loop tick", { isMeta: true, turnOrigin: "scheduled", scheduledTaskId: "t1" }),
  pushed("please look at the failing build", { origin: { kind: "human" }, turnOrigin: "human" }),
  queued("channel", channel("w2", "Status: BLOCKED")),
  queued("task-notification", "<task-notification>\n<summary>Background command done</summary>\n</task-notification>"),
  queued("human", "also check the docs"),
  pushed("<task-notification>\n<summary>legacy record with no origin</summary>\n</task-notification>"),
  pushed("a legacy typed message"),
  pushed([{ type: "tool_result", tool_use_id: "tu9", content: "ok" }]),
  pushed("[1 prior /loop wakeup found nothing actionable.]", { isMeta: true, turnCompanion: true }),
  pushed([{ type: "text", text: "Base directory for this skill: /skills/x" }], { isMeta: true }),
  pushed("stale before the window", { origin: { kind: "human" }, turnOrigin: "human" }, MONTH_AGO),
  assistant("g2", usage(1, 1, 1, 1)),
];

let root: string;

function transcript(profile: string, project: string, file: string, records: readonly unknown[]): string {
  const dir = join(root, profile, "projects", project);
  mkdirSync(dir, { recursive: true });
  const at = join(dir, file);
  writeFileSync(at, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n"));
  return at;
}

async function audit(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(["context-audit", "--root", root, ...args], { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env: {} });
  return { code, out, err };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "context-audit-"));
  transcript("agents", "-work-proj--worktrees-impl-1", "s1.jsonl", IMPLEMENTER);
  transcript("agents", "-work-proj", "s2.jsonl", REVIEWER);
  const old = transcript("server", "-work-active-work-ws", "s3.jsonl", OLD_COORDINATOR);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(old, monthAgo, monthAgo);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("context-audit report", () => {
  it("sums each role's spend once per message id and leaves out transcripts older than the window", async () => {
    const { code, out } = await audit("--days", "7");
    expect(code).toBe(0);
    expect(out).toMatch(/^implementer\s+1\s+3\s+1\.0k\s+1\.1k\s+2\.1k\s+125\s+0\.01$/m);
    expect(out).toMatch(/^reviewer\s+1\s+1\s+2\.0k\s+2\.0k\s+0\s+10\s+0\.01$/m);
    expect(out).not.toContain("coordinator");
  });

  it("lists the newest snapshot's layers and the instructions files per profile and role", async () => {
    const { out } = await audit();
    expect(out).toContain("inventory agents/implementer (newest snapshot 2026-10-20T09:30:00Z)");
    expect(out).toContain("system prompt: 2 blocks, 50 chars [11, 39]");
    expect(out).toContain("tool schemas: 2, 90 chars: Bash 45, Read 45");
    expect(out).toContain("instructions Project 300 chars /work/proj/CLAUDE.md");
  });

  it("weights tool results by the later calls that carry them, keyed by program and subcommand", async () => {
    const { out } = await audit();
    expect(out).toMatch(/^ {2}bash:pnpm test\s+raw\s+50\s+carried\s+100 /m);
  });
});

describe("context-audit wakes by trigger", () => {
  it("counts each coordinator's pushed messages by trigger across its sessions, inside the window only", async () => {
    transcript("server", "-work-active-work-ws", "g1.jsonl", COORDINATOR_GEN_1);
    transcript("server", "-work-active-work-ws", "g2.jsonl", COORDINATOR_GEN_2);
    const { out } = await audit();
    expect(out).toMatch(/^coordinator\s+sessions\s+digest\s+pr-notice\s+task-note\s+lifecycle\s+broker\s+host\s+cron\s+peer\s+owner\s+sdk\s+other\s+total$/m);
    expect(out).toMatch(/^ws-coord\s+2\s+1\s+1\s+3\s+1\s+1\s+1\s+1\s+3\s+3\s+1\s+0\s+16$/m);
  });

  it("leaves the wake table out when no coordinator session is in the window", async () => {
    const { out } = await audit();
    expect(out).not.toContain("wakes by trigger");
  });
});

describe("context-audit --assert-rule", () => {
  it("passes when every listed role's newest system prompt carries the marker", async () => {
    const { code, out } = await audit("--assert-rule", "Rule marker A.", "implementer");
    expect(code).toBe(0);
    expect(out).toBe("PASS agents/implementer: marker present (snapshot 2026-10-20T09:30:00Z)\n");
  });

  it("fails for a role whose prompt lacks the marker and for a role with no snapshot in the window", async () => {
    const { code, out } = await audit("--assert-rule", "Rule marker A.", "implementer,reviewer,coordinator");
    expect(code).toBe(1);
    expect(out).toContain("FAIL agents/reviewer: marker missing");
    expect(out).toContain("FAIL coordinator: no prompt_snapshot in the window");
  });

  it("refuses a marker given without its roles", async () => {
    const { code, err } = await audit("--assert-rule", "Rule marker A.");
    expect(code).toBe(2);
    expect(err).toContain("exactly two values");
  });
});
