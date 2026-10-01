import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSource } from "./extract.js";
import { POLICY } from "./fixtures.js";
import { openLedgerStore, type LedgerStore } from "./store.js";
import { transcriptSource } from "./transcripts.js";

/** Synthetic transcripts only: invented sessions, questions and paths. */

const SESSION = "sess-widgets";
const CWD = "/home/example/projects/widgets";
const MERGE_Q = "Merge PR #12 (the widget refresh)?";
const WRAP_Q = "What next?";

let dir: string;
let file: string;
let store: LedgerStore;

function line(fields: Record<string, unknown>, cwd = CWD): string {
  return JSON.stringify({ sessionId: SESSION, cwd, ...fields }) + "\n";
}

interface Question {
  header: string;
  question: string;
  options: { label: string; description?: string }[];
}

function ask(id: string, questions: Question[], ts = "2026-01-02T10:00:01Z", cwd = CWD): string {
  const content = [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }];
  return line({ type: "assistant", uuid: `a-${id}`, timestamp: ts, message: { role: "assistant", content } }, cwd);
}

function result(id: string, text: string, ts = "2026-01-02T10:05:00Z"): string {
  const block = { type: "tool_result", tool_use_id: id, content: text };
  return line({ type: "user", uuid: `r-${id}`, timestamp: ts, message: { role: "user", content: [block] } });
}

function answered(pairs: [string, string][]): string {
  return `The user answered: ${pairs.map(([q, a]) => `"${q}"="${a}"`).join(", ")}. Read the answers carefully.`;
}

const MERGE: Question = {
  header: "Merge #12",
  question: MERGE_Q,
  options: [{ label: "Squash-merge now (Recommended)", description: "CI is green" }, { label: "Hold" }],
};
const WRAP: Question = {
  header: "Next",
  question: WRAP_Q,
  options: [{ label: "Wrap the session (Recommended)" }, { label: "Keep going" }],
};

function extract() {
  const source = transcriptSource({ transcripts: async () => [{ path: file, namespace: "default" }] });
  return extractSource(store, source, POLICY);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "decider-transcripts-"));
  file = path.join(dir, "projects", "-home-example-projects-widgets", `${SESSION}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, line({ type: "user", uuid: "p1", timestamp: "2026-01-02T10:00:00Z", message: { role: "user", content: "go" } }));
  store = openLedgerStore(":memory:");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("transcript source", () => {
  it("writes one v2 row per question, pairing answers by tool_use_id when results arrive out of order", async () => {
    appendFileSync(file, ask("tu-merge", [MERGE]) + ask("tu-wrap", [WRAP]));
    appendFileSync(file, result("tu-wrap", "The user doesn't want to proceed with this tool use."));
    appendFileSync(file, result("tu-merge", answered([[MERGE_Q, "Hold until CI is green, then squash it"]])));

    const summary = await extract();
    const merge = store.get(`transcript:${SESSION}:tu-merge`);
    const wrap = store.get(`transcript:${SESSION}:tu-wrap`);

    expect(summary).toMatchObject({ read: 2, written: 2, pending: 0, errors: [] });
    expect(merge).toMatchObject({
      v: 2,
      category: "merge_gate",
      initiative: "widgets",
      recommended: "Squash-merge now",
      answer: "Hold until CI is green, then squash it",
      outcome: "redirect",
      options: MERGE.options,
      locator: { path: file, sessionId: SESSION, toolUseId: "tu-merge" },
    });
    expect(wrap).toMatchObject({ answer: null, outcome: null });
  });

  it("keys every question of a multi-question call apart", async () => {
    appendFileSync(file, ask("tu-both", [MERGE, WRAP]));
    appendFileSync(file, result("tu-both", answered([[MERGE_Q, "Hold"], [WRAP_Q, "Wrap the session (Recommended)"]])));

    await extract();

    expect(store.get(`transcript:${SESSION}:tu-both`)?.outcome).toBe("other");
    expect(store.get(`transcript:${SESSION}:tu-both#1`)?.outcome).toBe("accept");
  });

  it("writes nothing new when extraction runs again over the same transcript", async () => {
    appendFileSync(file, ask("tu-merge", [MERGE]) + result("tu-merge", answered([[MERGE_Q, "Hold"]])));
    await extract();

    const again = await extract();

    expect(again).toMatchObject({ read: 0, written: 0, alreadyIndexed: 0 });
    expect(store.count()).toBe(1);
  });

  it("reads only past the watermark when the transcript grows", async () => {
    appendFileSync(file, ask("tu-merge", [MERGE]) + result("tu-merge", answered([[MERGE_Q, "Hold"]])));
    await extract();
    appendFileSync(file, ask("tu-wrap", [WRAP], "2026-01-02T11:00:00Z"));
    appendFileSync(file, result("tu-wrap", answered([[WRAP_Q, "Keep going"]]), "2026-01-02T11:01:00Z"));

    const second = await extract();

    expect(second).toMatchObject({ read: 1, written: 1 });
    expect(store.count()).toBe(2);
  });

  it("holds an unanswered question back and writes it once the answer lands", async () => {
    appendFileSync(file, ask("tu-merge", [MERGE]));
    const first = await extract();
    appendFileSync(file, result("tu-merge", answered([[MERGE_Q, "Squash-merge now (Recommended)"]])));

    const second = await extract();

    expect(first).toMatchObject({ written: 0, pending: 1 });
    expect(second).toMatchObject({ written: 1, pending: 0 });
    expect(store.get(`transcript:${SESSION}:tu-merge`)?.outcome).toBe("accept");
  });

  it("never writes a row from a human-only project directory, nor one that names a listed person", async () => {
    const garden = "/home/example/projects/garden/beds";
    appendFileSync(file, ask("tu-garden", [MERGE], "2026-01-02T10:00:02Z", garden));
    appendFileSync(file, ask("tu-person", [{ ...MERGE, options: [{ label: "Hold", description: "Ask Zorblat" }] }]));
    appendFileSync(file, result("tu-garden", answered([[MERGE_Q, "Hold"]])));
    appendFileSync(file, result("tu-person", answered([[MERGE_Q, "Hold"]])));

    const summary = await extract();
    const again = await extract();

    expect(summary.excluded).toEqual({ "human-only-initiative": 0, "human-only-cwd": 1, "personal-data": 1 });
    expect([summary.written, again.read, store.count()]).toEqual([0, 0, 0]);
  });

  it("flags a row from an unmapped directory unclaimed", async () => {
    appendFileSync(file, ask("tu-merge", [MERGE], "2026-01-02T10:00:01Z", "/srv/scratch"));
    appendFileSync(file, result("tu-merge", answered([[MERGE_Q, "Hold"]])));

    await extract();

    expect(store.get(`transcript:${SESSION}:tu-merge`)).toMatchObject({ initiative: null, unclaimed: true });
  });

  it("reports an unreadable transcript without moving its watermark", async () => {
    rmSync(file);

    const summary = await extract();

    expect(summary.errors).toHaveLength(1);
    expect(store.sourceWatermarks("transcript").size).toBe(0);
  });
});
