import { describe, expect, it } from "vitest";
import { EventBook, SseParser, statusReportOf } from "./events.js";
import { EVENT_STREAM, NOW_MS } from "./fixture.js";

describe("SseParser", () => {
  it("yields the same frames however the stream is cut, and drops heartbeats", () => {
    const whole = new SseParser().push(EVENT_STREAM);
    const cut = new SseParser();
    const pieces = [];
    for (let at = 0; at < EVENT_STREAM.length; at += 13) pieces.push(...cut.push(EVENT_STREAM.slice(at, at + 13)));

    expect(whole.map((frame) => frame.event)).toEqual(["agent_spawned", "message", "message", "message"]);
    expect(pieces).toEqual(whole);
  });
});

describe("statusReportOf", () => {
  it("reads the status word and the PR number of a report", () => {
    expect(statusReportOf("Status: DONE_WITH_CONCERNS\nPR: example/repo#7\nHead: x", 5)).toEqual({ word: "DONE_WITH_CONCERNS", pr: "#7", atMs: 5 });
  });

  it("ignores a message that is not a report", () => {
    expect(statusReportOf("the status is fine", 5)).toBeNull();
  });
});

describe("EventBook", () => {
  it("folds each agent's newest report and its spawn task", () => {
    const book = new EventBook();
    for (const frame of new SseParser().push(EVENT_STREAM)) book.accept(frame);

    expect(book.reportOf("builder-a")).toEqual({ word: "DONE", pr: "#41", atMs: NOW_MS - 3 * 60_000 });
    expect(book.reportOf("fixer-d")?.word).toBe("BLOCKED");
    expect(book.reportOf("reviewer-b")).toBeNull();
    expect(book.taskOf("builder-a")).toBe("DEMO-12");
    expect(book.latestId).toBe(10);
  });

  it("skips a row it already folded, so a replay cannot move a report backwards", () => {
    const book = new EventBook();
    const frames = new SseParser().push(EVENT_STREAM);
    for (const frame of frames) book.accept(frame);

    const replayed = frames.map((frame) => book.accept(frame));

    expect(replayed.every((changed) => !changed)).toBe(true);
  });

  it("counts a presence change as a change with no row to fold", () => {
    expect(new EventBook().accept({ event: "session_status", data: '{"reason":"presence"}' })).toBe(true);
  });
});
