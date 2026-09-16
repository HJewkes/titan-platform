import { describe, expect, it } from "vitest";
import type { TranscriptHead } from "../corpus/transcripts.js";
import { briefProbe, collapseWhitespace, linkSpawn, type Spawn } from "./spawn-arm.js";

const PREAMBLE = "You are a spawned agent. Report to your coordinator via chat_send. ".repeat(4);

function spawn(scope: string, overrides: Partial<Spawn> = {}): Spawn {
  return {
    name: "agent",
    brief: `${PREAMBLE}\nSCOPE: ${scope} ${"filler words to give the brief length. ".repeat(6)}`,
    parentTranscript: "/t/parent.jsonl",
    timestamp: "2026-09-15T10:00:00.000Z",
    ...overrides,
  };
}

function head(file: string, firstUserText: string, startedAt?: string): TranscriptHead {
  return { file, firstUserText, ...(startedAt ? { startedAt } : {}) };
}

describe("briefProbe", () => {
  it("cuts past the shared preamble so sibling spawns stay distinguishable", () => {
    const a = briefProbe(spawn("the mazes system").brief)!;
    const b = briefProbe(spawn("the dinosaur system").brief)!;
    expect(a).not.toBe(b);
  });

  it("returns undefined for a brief too short to probe distinctively", () => {
    expect(briefProbe("do the thing")).toBeUndefined();
  });

  it("is whitespace-insensitive, since a transcript rewraps the brief", () => {
    expect(briefProbe(spawn("x").brief)).toBe(briefProbe(collapseWhitespace(spawn("x").brief)));
  });
});

describe("linkSpawn", () => {
  const target = spawn("the mazes system");

  it("links to the one transcript whose first user turn carries the brief", () => {
    const heads = [
      head("/t/parent.jsonl", target.brief),
      head("/t/child.jsonl", `preamble\n${target.brief}\nmore`),
      head("/t/other.jsonl", spawn("unrelated work").brief),
    ];
    expect(linkSpawn(target, heads)).toEqual({ transcript: "/t/child.jsonl", method: "brief-text" });
  });

  it("never links a spawn to the transcript that issued it", () => {
    expect(linkSpawn(target, [head("/t/parent.jsonl", target.brief)])).toBeUndefined();
  });

  it("matches across rewrapped whitespace", () => {
    const rewrapped = target.brief.replace(/ /g, "\n  ");
    expect(linkSpawn(target, [head("/t/child.jsonl", rewrapped)])?.transcript).toBe("/t/child.jsonl");
  });

  it("breaks a re-spawn tie on the earliest child starting at or after the spawn", () => {
    const heads = [
      head("/t/first.jsonl", target.brief, "2026-09-15T09:00:00.000Z"),
      head("/t/second.jsonl", target.brief, "2026-09-15T10:00:01.000Z"),
      head("/t/third.jsonl", target.brief, "2026-09-15T11:00:00.000Z"),
    ];
    expect(linkSpawn(target, heads)).toEqual({ transcript: "/t/second.jsonl", method: "brief-text+timestamp" });
  });

  it("reports no link rather than guessing when every candidate predates the spawn", () => {
    const heads = [
      head("/t/a.jsonl", target.brief, "2026-09-15T09:00:00.000Z"),
      head("/t/b.jsonl", target.brief, "2026-09-15T09:30:00.000Z"),
    ];
    expect(linkSpawn(target, heads)).toBeUndefined();
  });

  it("reports no link when nothing carries the brief", () => {
    expect(linkSpawn(target, [head("/t/x.jsonl", "unrelated")])).toBeUndefined();
  });
});
