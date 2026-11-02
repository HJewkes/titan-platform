import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { runVideo } from "./host.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture | undefined;
afterEach(() => fx?.cleanup());

describe("explainer run reflection", () => {
  it("keys a later run's reflection to the digest day its base run gathered", async () => {
    fx = fixture();
    const spool = mkdtempSync(path.join(tmpdir(), "reflection-spool-"));
    const reflection = { mode: "deposit" as const, asker: "acme-seat", spoolDir: spool };
    const draft = choppy();
    const last = draft.chapters[draft.chapters.length - 1]!.id;
    const script = { ...draft, chapters: draft.chapters.map((c) => (c.id === last ? { ...c, id: "reflection" } : c)), beats: draft.beats.map((b) => (b.chapter === last ? { ...b, chapter: "reflection" } : b)) };
    const host = () => fakeHost(fx!, fakeScriptModel(script), fakeRender(), { reflection });
    const gather = { adapter: "gatherDaily" as const, type: "repo-tour", day: "2030-01-02", repos: [], transcripts: [], initiative: "acme" };

    const first = await runVideo({ spine: fx.spine, facts: fx.facts, gather, to: "sheets" }, host());
    const second = await runVideo({ from: "export", base: first.runId }, host());

    expect([first.status, second.status], second.error).toEqual(["completed", "completed"]);
    const filed = readdirSync(spool).filter((name) => name.endsWith(".json")).map((name) => readFileSync(path.join(spool, name), "utf8"));
    expect(filed).toHaveLength(1);
    expect(filed[0]).toContain("daily-reflection:2030-01-02");
    rmSync(spool, { recursive: true, force: true });
  });
});
