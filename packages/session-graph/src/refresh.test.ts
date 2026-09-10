import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, resetIndex, type SessionGraph } from "./graph.js";
import { indexTranscript, refreshCorpus } from "./refresh.js";

const REPO = path.join(os.tmpdir(), "titan-session-graph-fixture-repo");
mkdirSync(path.join(REPO, ".git"), { recursive: true });
writeFileSync(path.join(REPO, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/demo.git\n');

const base = (fields: Record<string, unknown>) => ({ sessionId: "s1", cwd: REPO, gitBranch: "main", ...fields });
const prompt = (uuid: string, ts: string, text: string) => base({ type: "user", uuid, timestamp: ts, message: { role: "user", content: text } });
const assistant = (ts: string, content: unknown[]) =>
  base({ type: "assistant", timestamp: ts, message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content } });
const tool = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

const LINES_A = [
  base({ type: "mode", mode: "plan", timestamp: "2026-07-01T00:00:00Z" }),
  base({ type: "mode", mode: "plan", timestamp: "2026-07-01T00:00:01Z" }),
  prompt("p1", "2026-07-01T00:00:02Z", "fix the failing vitest suite"),
  assistant("2026-07-01T00:00:04Z", [tool("t1", "Edit", { file_path: `${REPO}/src/app.ts` })]),
  base({ type: "user", timestamp: "2026-07-01T00:00:05Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  assistant("2026-07-01T00:00:06Z", [{ type: "text", text: "done" }]),
  { sessionId: "s1", type: "pr-link", timestamp: "2026-07-01T00:00:07Z", prNumber: 7, prRepository: "acme/demo", prUrl: "https://github.com/acme/demo/pull/7" },
];
const LINES_B = [
  prompt("p2", "2026-07-01T00:00:10Z", "now merge it"),
  assistant("2026-07-01T00:00:11Z", [tool("t2", "Bash", { command: "gh pr merge 7 --squash" })]),
  base({ type: "mode", mode: "default", timestamp: "2026-07-01T00:00:12Z" }),
];

const render = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

let dir: string;
let graph: SessionGraph;
let transcript: DiscoveredTranscript;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-"));
  const absolutePath = path.join(dir, "s1.jsonl");
  writeFileSync(absolutePath, render(LINES_A));
  transcript = { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null };
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const count = (table: string) => (graph.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
// Wall-clock audit columns differ between passes by construction; everything else must match.
const stripClock = (row: unknown) => {
  const rest = { ...(row as Record<string, unknown>) };
  delete rest.t_indexed;
  delete rest.t_created;
  return rest;
};
const dumpOf = (tables: readonly string[]) =>
  tables.map((t) => `${t}:${JSON.stringify(graph.db.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all().map(stripClock))}`);
const dump = () => dumpOf(["fact", "session", "session_model_usage", "turn", "permission_phase", "pr", "file", "edge"]);
/** Only what `purgeTranscript` owns; `pr` and `file` are shared across transcripts and survive a rewind. */
const dumpOwned = () => dumpOf(["fact", "session", "session_model_usage", "turn", "permission_phase", "edge"]);

describe("task status (TP-20)", () => {
  const withCommands = (...commands: string[]) =>
    render([
      prompt("p1", "2026-07-01T00:00:00Z", "work the task"),
      ...commands.map((command, i) => assistant(`2026-07-01T00:01:0${i}Z`, [tool(`t${i}`, "Bash", { command })])),
    ]);

  const taskRows = () => graph.db.prepare("SELECT task_ref, status FROM task ORDER BY task_ref").all();

  it("records the status a done command states", async () => {
    writeFileSync(transcript.absolutePath, withCommands("active-work task done demo AW-23"));
    await refreshCorpus(graph, [transcript]);
    expect(taskRows()).toEqual([{ task_ref: "task:AW-23", status: "done" }]);
  });

  it("leaves the status null when the session only read the task", async () => {
    writeFileSync(transcript.absolutePath, withCommands("active-work task list demo AW-23"));
    await refreshCorpus(graph, [transcript]);
    expect(taskRows()).toEqual([{ task_ref: "task:AW-23", status: null }]);
  });

  it("upgrades an earlier bare mention when the task is closed later in the session", async () => {
    writeFileSync(transcript.absolutePath, withCommands("active-work task list demo AW-23", "active-work task done demo AW-23"));
    await refreshCorpus(graph, [transcript]);
    expect(taskRows()).toEqual([{ task_ref: "task:AW-23", status: "done" }]);
  });

  it("never lets a later bare mention erase a known status", async () => {
    writeFileSync(transcript.absolutePath, withCommands("active-work task done demo AW-23", "active-work task list demo AW-23"));
    await refreshCorpus(graph, [transcript]);
    expect(taskRows()).toEqual([{ task_ref: "task:AW-23", status: "done" }]);
  });

  it("keeps a status across a later chunk of the same transcript", async () => {
    writeFileSync(transcript.absolutePath, withCommands("active-work task done demo AW-23"));
    await refreshCorpus(graph, [transcript]);
    appendFileSync(transcript.absolutePath, render([assistant("2026-07-01T00:02:00Z", [tool("t9", "Bash", { command: "aw task list demo AW-23" })])]));
    await refreshCorpus(graph, [transcript]);
    expect(taskRows()).toEqual([{ task_ref: "task:AW-23", status: "done" }]);
  });
});

describe("task resolver (TP-22)", () => {
  const doneCommand = () =>
    render([
      prompt("p1", "2026-07-01T00:00:00Z", "work the task"),
      assistant("2026-07-01T00:01:00Z", [tool("t0", "Bash", { command: "active-work task done demo AW-23" })]),
    ]);
  const taskRows = () => graph.db.prepare("SELECT task_ref, task_id, initiative, title, status FROM task ORDER BY task_ref").all();
  beforeEach(() => writeFileSync(transcript.absolutePath, doneCommand()));

  it("leaves title and initiative unfilled when no resolver is given", async () => {
    const summary = await refreshCorpus(graph, [transcript]);
    expect(summary.tasks).toEqual({ requested: 0, applied: 0, failed: false });
    expect(taskRows()).toEqual([{ task_ref: "task:AW-23", task_id: "AW-23", initiative: null, title: null, status: "done" }]);
  });

  it("fills title and initiative and takes the resolver's status over the transcript's", async () => {
    const calls: (readonly string[])[] = [];
    const resolveTasks = (taskIds: readonly string[]) => {
      calls.push(taskIds);
      return new Map([["AW-23", { initiative: "demo", title: "Ship the seam", status: "blocked" }]]);
    };
    const summary = await refreshCorpus(graph, [transcript], { resolveTasks });
    expect(calls).toEqual([["AW-23"]]);
    expect(summary.tasks).toEqual({ requested: 1, applied: 1, failed: false });
    expect(taskRows()).toEqual([{ task_ref: "task:AW-23", task_id: "AW-23", initiative: "demo", title: "Ship the seam", status: "blocked" }]);
  });

  it("keeps the transcript's status for a field the resolver omits", async () => {
    await refreshCorpus(graph, [transcript], { resolveTasks: () => new Map([["AW-23", { title: "Ship the seam" }]]) });
    expect(taskRows()).toEqual([{ task_ref: "task:AW-23", task_id: "AW-23", initiative: null, title: "Ship the seam", status: "done" }]);
  });

  it("changes nothing when the resolver knows nothing about a task it was asked for", async () => {
    const bare = await refreshCorpus(graph, [transcript]);
    const withoutResolver = taskRows();
    resetIndex(graph);

    const summary = await refreshCorpus(graph, [transcript], { full: true, resolveTasks: () => new Map([["AW-23", null]]) });
    expect(summary.tasks).toEqual({ requested: 1, applied: 0, failed: false });
    expect(taskRows()).toEqual(withoutResolver);
    expect(summary.facts).toBe(bare.facts);
  });

  it("records a task the corpus never mentioned when the resolver volunteers one", async () => {
    await refreshCorpus(graph, [transcript], {
      resolveTasks: () => new Map([["AW-99", { initiative: "demo", title: "Never worked on", status: "open" }]]),
    });
    expect(taskRows()).toEqual([
      { task_ref: "task:AW-23", task_id: "AW-23", initiative: null, title: null, status: "done" },
      { task_ref: "task:AW-99", task_id: "AW-99", initiative: "demo", title: "Never worked on", status: "open" },
    ]);
  });

  it("survives a resolver that throws, reporting the failure instead of losing the pass", async () => {
    const summary = await refreshCorpus(graph, [transcript], {
      resolveTasks: () => {
        throw new Error("task store is gone");
      },
    });
    expect(summary).toMatchObject({ indexed: 1, tasks: { requested: 1, applied: 0, failed: true } });
    expect(summary.tasks.error).toBe("task store is gone");
    expect(taskRows()).toEqual([{ task_ref: "task:AW-23", task_id: "AW-23", initiative: null, title: null, status: "done" }]);
  });

  it("honours the resolver from indexTranscript as well as refreshCorpus", async () => {
    const outcome = await indexTranscript(graph, transcript, {
      resolveTasks: () => new Map([["AW-23", { title: "Ship the seam" }]]),
    });
    expect(outcome.tasks).toEqual({ requested: 1, applied: 1, failed: false });
    expect(taskRows()).toEqual([{ task_ref: "task:AW-23", task_id: "AW-23", initiative: null, title: "Ship the seam", status: "done" }]);
  });
});

describe("refreshCorpus", () => {
  it("indexes a transcript into facts, sessions, usage, phases, assets, edges, and searchable spans", async () => {
    const summary = await refreshCorpus(graph, [transcript]);
    expect(summary).toMatchObject({ transcripts: 1, indexed: 1, facts: LINES_A.length, turnsRolledUp: 1 });
    expect(graph.db.prepare("SELECT * FROM session").get()).toMatchObject({ session_id: "s1", git_branch: "main", turn_count: 2 });
    expect(graph.db.prepare("SELECT * FROM session_model_usage").get()).toMatchObject({ model: "m", input_tokens: 2, request_count: 2 });
    expect(count("permission_phase")).toBe(1);
    expect(graph.db.prepare("SELECT * FROM turn").get()).toMatchObject({ prompt_id: "p1", turn_index: 0, tool_call_count: 1 });
    expect(graph.edges.from("session:s1").map((e) => `${e.relation} ${e.targetRef}`)).toEqual(
      expect.arrayContaining(["touched file:demo/src/app.ts", "linked pr:acme/demo#7", "worked branch:demo/main"]),
    );
    expect(graph.edges.from("session:s1")[0]?.factId).not.toBeNull();
    expect(graph.spans.search('"vitest"')[0]).toMatchObject({ ownerRef: "session:s1", field: "prompt", sourceId: 1 });
    expect(graph.transcripts.get(transcript.displayPath)).toMatchObject({ status: "ok", lastOffset: Buffer.byteLength(render(LINES_A)) });
  });

  it("is idempotent and applies only the appended delta on the next pass", async () => {
    await refreshCorpus(graph, [transcript]);
    const again = await refreshCorpus(graph, [transcript]);
    expect(again).toMatchObject({ unchanged: 1, facts: 0 });
    const before = dump();

    appendFileSync(transcript.absolutePath, render(LINES_B));
    const delta = await refreshCorpus(graph, [transcript]);
    expect(delta).toMatchObject({ indexed: 1, facts: LINES_B.length });
    expect(dump()).not.toEqual(before);
    expect(count("turn")).toBe(2);
    expect(graph.db.prepare("SELECT turn_index FROM turn WHERE prompt_id = 'p2'").get()).toEqual({ turn_index: 1 });
    expect(graph.db.prepare("SELECT state, merged_at FROM pr").get()).toEqual({ state: "merged", merged_at: "2026-07-01T00:00:11Z" });
    expect(graph.db.prepare("SELECT to_mode, t_invalid FROM permission_phase ORDER BY phase_id").all()).toEqual([
      { to_mode: "plan", t_invalid: "2026-07-01T00:00:12Z" },
      { to_mode: "default", t_invalid: null },
    ]);
  });

  it("converges: chunked passes equal a full rebuild from zero", async () => {
    await refreshCorpus(graph, [transcript]);
    appendFileSync(transcript.absolutePath, render(LINES_B));
    await refreshCorpus(graph, [transcript]);
    const chunked = dump();

    resetIndex(graph);
    expect(count("fact")).toBe(0);
    expect(graph.transcripts.get(transcript.displayPath)?.lastOffset).toBe(0);
    await refreshCorpus(graph, [transcript], { full: true });
    expect(dump()).toEqual(chunked);
  });

  it("rebuilds a rewritten transcript's rows rather than accumulating onto them", async () => {
    await refreshCorpus(graph, [transcript]);
    writeFileSync(transcript.absolutePath, render(LINES_A.slice(0, 4)));
    expect(await refreshCorpus(graph, [transcript])).toMatchObject({ rewound: 1 });
    const afterRewind = dumpOwned();

    // What a graph that had only ever seen the truncated file holds.
    resetIndex(graph);
    await refreshCorpus(graph, [transcript], { full: true });

    expect(afterRewind).toEqual(dumpOwned());
    // Scope, asserted rather than assumed: the pr row came from a line the
    // rewrite removed, and survives because many transcripts can assert it.
    expect(count("pr")).toBe(0);
  });

  it("restores a missing transcript to ok when the file comes back", async () => {
    const content = render(LINES_A);
    await refreshCorpus(graph, [transcript]);
    rmSync(transcript.absolutePath);
    await refreshCorpus(graph, [transcript]);
    expect(graph.transcripts.get(transcript.displayPath)?.status).toBe("missing");

    writeFileSync(transcript.absolutePath, content);
    await refreshCorpus(graph, [transcript]);

    expect(graph.transcripts.get(transcript.displayPath)?.status).toBe("ok");
  });

  it("leaves a quarantined transcript quarantined when its bytes have not changed", async () => {
    await refreshCorpus(graph, [transcript]);
    graph.transcripts.markStatus(transcript.displayPath, "quarantined", "bad line");

    await refreshCorpus(graph, [transcript]);

    expect(graph.transcripts.get(transcript.displayPath)?.status).toBe("quarantined");
  });

  it("rewinds a rewritten transcript and marks a vanished one missing", async () => {
    await refreshCorpus(graph, [transcript]);
    writeFileSync(transcript.absolutePath, render(LINES_A.slice(0, 3)));
    expect(await refreshCorpus(graph, [transcript])).toMatchObject({ rewound: 1 });

    rmSync(transcript.absolutePath);
    const gone = await refreshCorpus(graph, [transcript]);
    expect(gone.missing).toBe(1);
    expect(graph.transcripts.get(transcript.displayPath)?.status).toBe("missing");
    expect(count("fact")).toBeGreaterThan(0);

    const absent = await refreshCorpus(graph, []);
    expect(absent.markedMissing).toBe(0);
  });

  it("quarantines a transcript with a malformed line instead of failing the pass", async () => {
    appendFileSync(transcript.absolutePath, "not json\n");
    const summary = await refreshCorpus(graph, [transcript]);
    expect(summary.quarantined).toBe(1);
    expect(graph.transcripts.get(transcript.displayPath)).toMatchObject({ status: "quarantined", lastOffset: 0 });
  });
});
