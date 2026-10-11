import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { openSessionGraph, type SessionGraph } from "@titan-design/session-graph";
import { activeWorkClient } from "./active-work.js";
import { graphCommands, type EgoGraph, type GraphSource } from "./graph.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

// Synthetic refs and records only; nothing here comes from a real workspace or session graph.
const RUN = "0a1b2c3d-0000-4000-8000-0000000000aa";
const CHILD = "0a1b2c3d-0000-4000-8000-0000000000bb";
const OTHER = "0a1b2c3d-0000-4000-8000-0000000000cc";
const WRAP = "2031-03-01-relay-wrap";

/** As active-work's `context.graph` answers for OR-1: a task, a session file and an initiative's artifacts name it. */
const REFERENCES = [
  { slug: "orbit-relay", source: "task", file: "tasks/OR-7.yml", field: "notes", text: "Follows OR-1" },
  { slug: "orbit-relay", source: "task", file: "tasks/OR-7.yml", field: "done_when", text: "After OR-1" },
  { slug: "orbit-relay", source: "session", file: "sessions/2031-03-02-handoff.md", field: "body:L3", text: "OR-1 next" },
  { slug: "orbit-relay", source: "artifacts", file: "artifacts.yml", field: "branches[0].name", text: "pc-or-1-retry" },
];

let daemon: FakeDaemon | undefined;
let dir: string;
let graphPath: string;
let calls: string[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-graph-"));
  graphPath = path.join(dir, "graph.sqlite3");
  calls = [];
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(dir, { recursive: true, force: true });
});

function answer(command: string, args: Record<string, unknown>): unknown {
  calls.push(`${command}:${String(args.id)}`);
  if (command !== "context.graph") throw new Error(`No answer for ${command}`);
  const references = args.id === "OR-1" ? REFERENCES : [];
  return { id: args.id, kind: "task", subject: null, references, initiatives_scanned: [], errors: [] };
}

type Seed = (graph: SessionGraph) => void;

const edge = (graph: SessionGraph, sourceRef: string, relation: string, targetRef: string, extra: { tValid?: string; confidence?: number; attrs?: Record<string, unknown> } = {}) =>
  graph.edges.assert({ sourceRef, relation, targetRef, tValid: extra.tValid ?? "2031-03-01T10:00:00Z", ...extra });

function session(graph: SessionGraph, id: string, agent: string, title: string): void {
  graph.db.prepare("INSERT INTO session (session_id, started_at, ended_at, cwd, ai_title, turn_count) VALUES (?, '2031-03-01T10:00:00Z', NULL, '/work/example', ?, 3)").run(id, title);
  graph.db.prepare("INSERT INTO session_origin (session_id, origin_system, agent_name, resolved_at) VALUES (?, 'agent-chat', ?, '2031-03-01T00:00:00Z')").run(id, agent);
}

/** One relay task worked by one session, which spawned a child and touched files on a hub branch. */
const relay: Seed = (graph) => {
  session(graph, RUN, "impl-a", "Retry the handshake");
  session(graph, CHILD, "impl-b", "Review the retry");
  session(graph, OTHER, "impl-c", "Unrelated work");
  for (const target of ["task:OR-1", "task:OR-2", "note:orbit-relay/notes/retry.md", `session:${RUN}`, `session:${WRAP}`]) edge(graph, "initiative:orbit-relay", "holds", target);
  edge(graph, `session:${RUN}`, "ran", "task:OR-1", { confidence: 0.6, attrs: { via: "origin", source: "brief-anchor" } });
  edge(graph, `session:${RUN}`, "linked", "pr:example/orbit#41");
  edge(graph, `session:${RUN}`, "touched", "file:orbit/src/retry.ts");
  edge(graph, `session:${RUN}`, "edited_by_human", "file:orbit/src/retry.ts");
  edge(graph, `session:${RUN}`, "touched", "file:orbit/src/backoff.ts");
  edge(graph, `session:${RUN}`, "worked", "branch:orbit/main");
  edge(graph, `session:${OTHER}`, "worked", "branch:orbit/main");
  edge(graph, `session:${RUN}`, "spawned", `session:${CHILD}`);
  edge(graph, `session:${RUN}`, "spawned", "agent:toolu_01synthetic");
  edge(graph, "agent:toolu_01synthetic", "transcribed_in", `session:${CHILD}`);
  edge(graph, "note:orbit-relay/notes/retry.md", "mentions", "task:OR-1");
  edge(graph, "note:orbit-relay/notes/retry.md", "shares_tag", "note:garden-plan/notes/seeds.md");
  edge(graph, "note:garden-plan/notes/seeds.md", "shares_tag", "note:orbit-relay/notes/retry.md");
};

function seed(...seeds: Seed[]): void {
  const graph = openSessionGraph(graphPath);
  try {
    for (const apply of seeds) apply(graph);
  } finally {
    graph.db.close();
  }
}

async function ego(args: Record<string, unknown>, sessionsPath = graphPath) {
  daemon = await startFakeDaemon({ ok: true }, answer);
  const source: GraphSource = { activeWork: activeWorkClient(daemon.port), sessions: { graphPath: sessionsPath } };
  const { envelope, exitCode } = await invokeCommand(graphCommands(source)["graph.ego"], args, { warnings: [], format: "json" });
  return { envelope, exitCode, data: (envelope as { data?: EgoGraph }).data as EgoGraph };
}

const refs = (data: EgoGraph) => data.nodes.map((node) => node.ref).sort();
const node = (data: EgoGraph, ref: string) => data.nodes.find((entry) => entry.ref === ref);
const kinds = (data: EgoGraph) => [...new Set(data.edges.map((entry) => entry.kind))].sort();

describe("graph.ego at depth 1", () => {
  it("returns typed nodes and edges from the session graph and context.graph mentions", async () => {
    seed(relay);
    const { data } = await ego({ ref: "task:OR-1" });

    expect(refs(data)).toEqual([
      "initiative:orbit-relay", "note:orbit-relay/notes/retry.md", `session:${RUN}`, "task:OR-1", "task:OR-7", "wrap:orbit-relay/2031-03-02-handoff",
    ]);
    expect(kinds(data)).toEqual(["holds", "mentions", "ran"]);
    expect(node(data, "task:OR-1")).toMatchObject({ kind: "task", depth: 0, expanded: true });
    expect(node(data, `session:${RUN}`)).toMatchObject({ kind: "session", depth: 1, label: "Retry the handshake", expanded: false });
    expect(node(data, "wrap:orbit-relay/2031-03-02-handoff")?.kind).toBe("wrap");
    expect(data.sources).toEqual({ graph: "ok", mentions: "ok" });
    expect(data.degraded).toBeNull();
    expect(data.truncated).toBeNull();
  });

  it("keeps a low-confidence edge's confidence and its origin", async () => {
    seed(relay);
    const { data } = await ego({ ref: "task:OR-1" });
    expect(data.edges.find((entry) => entry.kind === "ran")).toEqual({
      source: `session:${RUN}`, target: "task:OR-1", kind: "ran", validFrom: "2031-03-01T10:00:00Z", confidence: 0.6, via: "origin",
    });
  });

  it("sends one mention per referring file, the initiative's artifacts as the initiative", async () => {
    seed(relay);
    const { data } = await ego({ ref: "task:OR-1" });
    const traced = data.edges.filter((entry) => entry.via === "context.graph").map((entry) => entry.source).sort();
    expect(traced).toEqual(["initiative:orbit-relay", "task:OR-7", "wrap:orbit-relay/2031-03-02-handoff"]);
  });

  it("types a holds target that is a wrap id, not a transcript uuid, as a wrap", async () => {
    seed(relay);
    const { data } = await ego({ ref: "initiative:orbit-relay" });
    expect(node(data, `session:${WRAP}`)).toMatchObject({ kind: "wrap", label: WRAP });
    expect(node(data, `session:${RUN}`)?.kind).toBe("session");
    expect(calls).toEqual([]);
  });

  it("sends shares_tag once, lower ref first", async () => {
    seed(relay);
    const { data } = await ego({ ref: "note:orbit-relay/notes/retry.md" });
    expect(data.edges.filter((entry) => entry.kind === "shares_tag")).toEqual([
      expect.objectContaining({ source: "note:garden-plan/notes/seeds.md", target: "note:orbit-relay/notes/retry.md" }),
    ]);
  });

  it("reports full degree before caps", async () => {
    seed(relay);
    const { data } = await ego({ ref: "task:OR-1" });
    // holds, ran, linked, two touched, edited_by_human, worked, spawned session, and ran_as; the agent:<toolUseId> edge is not counted.
    expect(node(data, `session:${RUN}`)?.degree).toBe(9);
  });
});

describe("graph.ego at depth 2", () => {
  it("expands depth-1 nodes, collapses files and branches into counts and stops at hubs", async () => {
    seed(relay);
    const { data } = await ego({ ref: "task:OR-1", depth: 2 });

    expect(refs(data)).toEqual(expect.arrayContaining(["agent:impl-a", "pr:example/orbit#41", `session:${CHILD}`]));
    expect(node(data, `session:${CHILD}`)).toMatchObject({ depth: 2, expanded: false });
    expect(node(data, `session:${RUN}`)?.expanded).toBe(true);
    expect(node(data, "initiative:orbit-relay")?.expanded).toBe(false);
    expect(refs(data)).not.toContain("task:OR-2");
    expect(refs(data).filter((ref) => ref.startsWith("file:") || ref.startsWith("branch:"))).toEqual([]);
    expect(data.counts).toMatchObject({ file: 2, branch: 1, agent: 1 });
    expect(data.truncated?.collapsed).toEqual(expect.arrayContaining([
      { kind: "file", via: "touched", count: 2 },
      { kind: "file", via: "edited_by_human", count: 1 },
      { kind: "branch", via: "worked", count: 1 },
    ]));
  });

  it("synthesises ran_as by agent name and never sends a session-read agent ref", async () => {
    seed(relay);
    const { data } = await ego({ ref: "task:OR-1", depth: 2 });
    expect(data.edges).toContainEqual(expect.objectContaining({ source: "agent:impl-a", target: `session:${RUN}`, kind: "ran_as" }));
    expect(JSON.stringify(data)).not.toContain("toolu_");
  });

  it("opens an agent ego through the sessions it ran", async () => {
    seed(relay);
    const { data } = await ego({ ref: "agent:impl-a", depth: 2 });
    expect(node(data, `session:${RUN}`)).toMatchObject({ depth: 1, expanded: true });
    expect(node(data, "task:OR-1")?.depth).toBe(2);
    expect(node(data, "agent:impl-a")?.degree).toBe(1);
  });

  it("returns files and branches when the caller opts in, without expanding a main branch", async () => {
    seed(relay);
    const { data } = await ego({ ref: `session:${RUN}`, depth: 2, include: ["file", "branch"] });
    expect(refs(data)).toEqual(expect.arrayContaining(["file:orbit/src/retry.ts", "branch:orbit/main"]));
    expect(node(data, "branch:orbit/main")?.expanded).toBe(false);
    expect(refs(data)).not.toContain(`session:${OTHER}`);
  });
});

/** An initiative holding 45 tasks and 3 notes. */
const crowded: Seed = (graph) => {
  for (let i = 1; i <= 45; i++) edge(graph, "initiative:crowd", "holds", `task:CR-${i}`, { tValid: `2031-03-01T10:${String(i).padStart(2, "0")}:00Z` });
  for (const name of ["a", "b", "c"]) edge(graph, "initiative:crowd", "holds", `note:crowd/${name}.md`);
};

describe("graph.ego caps", () => {
  it("keeps 40 of a kind at depth 1, the newest, and counts the rest", async () => {
    seed(crowded);
    const { data } = await ego({ ref: "initiative:crowd" });
    const tasks = data.nodes.filter((entry) => entry.kind === "task");
    expect(tasks).toHaveLength(40);
    expect(tasks.map((entry) => entry.ref)).toContain("task:CR-45");
    expect(tasks.map((entry) => entry.ref)).not.toContain("task:CR-1");
    expect(data.counts).toEqual({ task: 45, note: 3 });
    expect(data.truncated).toMatchObject({ nodeCap: 150, edgeCap: 300, omitted: { task: 5 }, omittedEdges: 5 });
  });

  it("keeps a node the depth-1 cap dropped out of depth 2, counted as omitted once", async () => {
    const id = (i: number) => `0a1b2c3d-0000-4000-8000-${String(i).padStart(12, "0")}`;
    seed((graph) => {
      for (let i = 1; i <= 41; i++) edge(graph, `session:${id(i)}`, "ran", "task:CR-1", { tValid: `2031-03-01T10:${String(i).padStart(2, "0")}:00Z` });
      edge(graph, `session:${id(41)}`, "spawned", `session:${id(1)}`);
    });
    const { data } = await ego({ ref: "task:CR-1", depth: 2 });

    expect(node(data, `session:${id(41)}`)?.depth).toBe(1);
    expect(node(data, `session:${id(1)}`)).toBeUndefined();
    expect(data.counts.session).toBe(41);
    expect(data.truncated?.omitted).toEqual({ session: 1 });
  });

  it("fills a lowered node cap round-robin so one kind cannot crowd out another", async () => {
    seed(crowded);
    const { data } = await ego({ ref: "initiative:crowd", limit: { nodes: 7, edges: 4 } });
    expect(data.nodes).toHaveLength(7);
    expect(data.nodes.filter((entry) => entry.kind === "note")).toHaveLength(3);
    expect(data.edges).toHaveLength(4);
    expect(data.truncated).toMatchObject({ nodeCap: 7, edgeCap: 4, omitted: { task: 42 }, omittedEdges: 44 });
  });

  it("refuses a limit above the caps", async () => {
    seed(crowded);
    const { exitCode } = await ego({ ref: "initiative:crowd", limit: { nodes: 151 } });
    expect(exitCode).toBe(EXIT.DATAERR);
  });

  it("refuses a ref of no known kind", async () => {
    const { exitCode } = await ego({ ref: "artifact:abc" });
    expect(exitCode).toBe(EXIT.DATAERR);
  });
});

describe("graph.ego without the session graph", () => {
  it("returns context.graph mention edges only, at depth 1, flagged degraded", async () => {
    const { data } = await ego({ ref: "task:OR-1", depth: 2 }, path.join(dir, "absent.sqlite3"));

    expect(data.depth).toBe(1);
    expect(kinds(data)).toEqual(["mentions"]);
    expect(refs(data)).toEqual(["initiative:orbit-relay", "task:OR-1", "task:OR-7", "wrap:orbit-relay/2031-03-02-handoff"]);
    expect(data.sources).toEqual({ graph: "absent", mentions: "ok", fallback: "mentions" });
    expect(data.degraded).toMatchObject({ reason: "graph-missing" });
  });

  it("returns the center alone when neither upstream knows it", async () => {
    const { data } = await ego({ ref: "agent:impl-a" }, path.join(dir, "absent.sqlite3"));
    expect(refs(data)).toEqual(["agent:impl-a"]);
    expect(data.sources).toEqual({ graph: "absent", mentions: "skipped", fallback: "mentions" });
  });
});
