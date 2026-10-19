import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionEventText, type SessionEventRef } from "./event-text.js";
import type { TranscriptRoot } from "./discover.js";

const SESSION = "0a1b2c3d-synthetic";
const lines = [
  { type: "user", sessionId: SESSION, message: { role: "user", content: "Which cache layout?" } },
  {
    type: "assistant",
    sessionId: SESSION,
    message: { role: "assistant", content: [{ type: "text", text: "The flat layout keeps every read\nto one lookup." }] },
  },
].map((line) => JSON.stringify(line));
const text = `${lines.join("\n")}\n`;
const second: SessionEventRef = { session: SESSION, byteOffset: Buffer.byteLength(lines[0]!) + 1, byteLength: Buffer.byteLength(lines[1]!) };

let configDir: string;
let roots: TranscriptRoot[];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "session-event-text-"));
  mkdirSync(join(configDir, "projects", "-work-repo"), { recursive: true });
  writeFileSync(join(configDir, "projects", "-work-repo", `${SESSION}.jsonl`), text);
  roots = [{ root: join(configDir, "projects"), account: "default" }];
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("readSessionEventText", () => {
  it("returns the message text of the one transcript line the span names", async () => {
    expect(await readSessionEventText(second, { roots })).toBe("The flat layout keeps every read\nto one lookup.");
  });

  it("reads the first line, whose span starts the file", async () => {
    const first = { session: SESSION, byteOffset: 0, byteLength: Buffer.byteLength(lines[0]!) };
    expect(await readSessionEventText(first, { roots })).toBe("Which cache layout?");
  });

  it("returns null for a span that starts or ends inside a line", async () => {
    expect(await readSessionEventText({ ...second, byteOffset: second.byteOffset + 1, byteLength: second.byteLength - 1 }, { roots })).toBeNull();
    expect(await readSessionEventText({ ...second, byteLength: second.byteLength - 1 }, { roots })).toBeNull();
  });

  it("returns null for a span over two lines or past the end of the file", async () => {
    expect(await readSessionEventText({ session: SESSION, byteOffset: 0, byteLength: Buffer.byteLength(text) - 1 }, { roots })).toBeNull();
    expect(await readSessionEventText({ ...second, byteLength: second.byteLength + 1 }, { roots })).toBeNull();
  });

  it("returns null for a session no root holds, or a span that is not a length", async () => {
    expect(await readSessionEventText({ ...second, session: "no-such-session" }, { roots })).toBeNull();
    expect(await readSessionEventText({ ...second, byteLength: 0 }, { roots })).toBeNull();
  });
});
