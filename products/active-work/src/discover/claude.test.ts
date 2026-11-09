import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "./claude.js";

const ORIG_ROOT = process.env.CLAUDE_PROJECTS_ROOT;
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "aw-claude-char-"));
  process.env.CLAUDE_PROJECTS_ROOT = root;
});

afterEach(() => {
  if (ORIG_ROOT === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
  else process.env.CLAUDE_PROJECTS_ROOT = ORIG_ROOT;
  rmSync(root, { recursive: true, force: true });
});

function writeSession(
  project: string,
  id: string,
  records: unknown[],
  mtimeSec?: number
): string {
  const dir = path.join(root, project);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"));
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

const userMsg = (text: string) => ({
  type: "user",
  message: { content: text },
});

describe("discoverClaudeSessions", () => {
  it("returns empty result when the projects root does not exist", async () => {
    process.env.CLAUDE_PROJECTS_ROOT = path.join(root, "missing");
    expect(await discoverClaudeSessions()).toEqual({ hits: [], errors: [] });
  });

  it("reports an error when the projects root is not a directory", async () => {
    const file = path.join(root, "file");
    writeFileSync(file, "x");
    process.env.CLAUDE_PROJECTS_ROOT = file;
    const result = await discoverClaudeSessions();
    expect(result.hits).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].source).toBe("claude-session");
  });

  it("builds one hit per cwd with metadata and detail", async () => {
    writeSession(
      "p1",
      "sess-a",
      [{ cwd: "/work/alpha" }, userMsg("  hello   world ")],
      1_000_000
    );
    const { hits, errors } = await discoverClaudeSessions();
    expect(errors).toEqual([]);
    expect(hits).toEqual([
      {
        source: "claude-session",
        ref: "/work/alpha",
        detail: "1 session(s) at /work/alpha — hello world",
        metadata: {
          cwd: "/work/alpha",
          sessionCount: 1,
          lastMtime: new Date(1_000_000_000).toISOString(),
          lastSessionId: "sess-a",
          subject: "hello world",
        },
      },
    ]);
  });

  it("omits the subject suffix when no message or summary exists", async () => {
    writeSession("p1", "s", [{ cwd: "/work/alpha" }]);
    const { hits } = await discoverClaudeSessions();
    expect(hits[0].detail).toBe("1 session(s) at /work/alpha");
    expect(hits[0].metadata?.subject).toBe("");
  });

  it("aggregates sessions across project dirs by cwd, newest wins", async () => {
    writeSession(
      "p1",
      "old",
      [{ cwd: "/work/alpha" }, userMsg("old subject")],
      1000
    );
    writeSession(
      "p2",
      "new",
      [{ cwd: "/work/alpha" }, userMsg("new subject")],
      2000
    );
    writeSession("p2", "other", [{ cwd: "/work/beta" }], 1500);
    const { hits } = await discoverClaudeSessions();
    const alpha = hits.find((h) => h.ref === "/work/alpha");
    expect(hits).toHaveLength(2);
    expect(alpha?.metadata).toMatchObject({
      sessionCount: 2,
      lastSessionId: "new",
      subject: "new subject",
    });
  });

  it("keeps the existing subject when a newer session has none", async () => {
    writeSession("p1", "old", [{ cwd: "/w" }, userMsg("kept")], 1000);
    writeSession("p1", "new", [{ cwd: "/w" }], 2000);
    const { hits } = await discoverClaudeSessions();
    expect(hits[0].metadata).toMatchObject({
      lastSessionId: "new",
      subject: "kept",
    });
  });

  it("fills an empty subject from an older session", async () => {
    writeSession("p1", "new", [{ cwd: "/w" }], 2000);
    writeSession("p1", "old", [{ cwd: "/w" }, userMsg("late subject")], 1000);
    const { hits } = await discoverClaudeSessions();
    expect(hits[0].metadata).toMatchObject({
      lastSessionId: "new",
      subject: "late subject",
    });
  });

  it("does not replace a subject from an older session", async () => {
    writeSession("p1", "new", [{ cwd: "/w" }, userMsg("first")], 2000);
    writeSession("p1", "old", [{ cwd: "/w" }, userMsg("second")], 1000);
    const { hits } = await discoverClaudeSessions();
    expect(hits[0].metadata).toMatchObject({
      sessionCount: 2,
      subject: "first",
    });
  });

  it("prefers the last compaction summary over the first user message", async () => {
    writeSession("p1", "s", [
      { cwd: "/w" },
      userMsg("first message"),
      { type: "summary", summary: "one" },
      { type: "summary", summary: "  two  " },
    ]);
    const { hits } = await discoverClaudeSessions();
    expect(hits[0].metadata?.subject).toBe("[compaction] two");
  });

  it("takes the first non-empty text block from array content", async () => {
    writeSession("p1", "s", [
      { cwd: "/w" },
      {
        type: "user",
        message: {
          content: [
            { type: "image" },
            { type: "text", text: "  " },
            { type: "text", text: " block text " },
          ],
        },
      },
      userMsg("later"),
    ]);
    const { hits } = await discoverClaudeSessions();
    expect(hits[0].metadata?.subject).toBe("block text");
  });

  it("truncates long subjects to 120 characters with an ellipsis", async () => {
    writeSession("p1", "s", [{ cwd: "/w" }, userMsg("x".repeat(300))]);
    const { hits } = await discoverClaudeSessions();
    expect(hits[0].metadata?.subject).toBe(`${"x".repeat(119)}…`);
  });

  it("uses the first non-empty cwd and skips malformed lines and non-objects", async () => {
    const file = writeSession("p1", "s", []);
    writeFileSync(
      file,
      [
        "not json",
        "null",
        "42",
        "",
        JSON.stringify({ cwd: "" }),
        JSON.stringify({ cwd: "/first" }),
        JSON.stringify({ cwd: "/second" }),
      ].join("\n")
    );
    const { hits } = await discoverClaudeSessions();
    expect(hits.map((h) => h.ref)).toEqual(["/first"]);
  });

  it("scans only the first 200 lines", async () => {
    const records: unknown[] = Array.from({ length: 200 }, () => ({}));
    records.push({ cwd: "/too-late" });
    writeSession("p1", "s", records);
    expect((await discoverClaudeSessions()).hits).toEqual([]);
  });

  it("ignores sessions without a cwd, non-jsonl files and loose files in root", async () => {
    writeSession("p1", "nocwd", [userMsg("hi")]);
    writeFileSync(path.join(root, "p1", "notes.txt"), '{"cwd":"/x"}');
    writeFileSync(path.join(root, "stray.jsonl"), '{"cwd":"/y"}');
    expect(await discoverClaudeSessions()).toEqual({ hits: [], errors: [] });
  });

  it.skipIf(process.getuid?.() === 0)(
    "records a per-file error and keeps scanning the rest",
    async () => {
      const broken = writeSession("p1", "broken", [{ cwd: "/x" }]);
      chmodSync(broken, 0o000);
      writeSession("p1", "good", [{ cwd: "/w" }]);
      const { hits, errors } = await discoverClaudeSessions();
      expect(hits.map((h) => h.ref)).toEqual(["/w"]);
      expect(errors).toHaveLength(1);
      expect(errors[0].source).toBe("claude-session:broken.jsonl");
    }
  );
});
