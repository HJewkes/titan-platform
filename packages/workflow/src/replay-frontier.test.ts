import { describe, expect, it } from "vitest";
import { ReplayFrontier } from "./replay-frontier.js";

describe("ReplayFrontier", () => {
  it("settles once every recorded key is read, in any order, ignoring keys it never recorded", async () => {
    const frontier = new ReplayFrontier(["a", "b", "c"]);
    frontier.read("c");
    frontier.read("unrecorded");
    frontier.read("a");
    frontier.read("b");

    expect(frontier.unread()).toBe(0);
    expect(await frontier.settled()).toBe(true);
  });

  it("reports the first unread key in recording order when a turn passes with no read", async () => {
    const frontier = new ReplayFrontier(["a", "b", "c"]);
    frontier.read("a");
    frontier.read("unrecorded");

    expect(await frontier.settled()).toBe(false);
    expect(frontier.unread()).toBe(2);
    expect(frontier.nextUnread()).toBe("b");
    expect(frontier.evidence("assisted", "approve-merge")).toBe('replay diverged: assisted("approve-merge") ran live with 2 recorded results unread, next b');
  });

  it("waits for reads a concurrent branch makes on later turns", async () => {
    const frontier = new ReplayFrontier(["a", "b", "c"]);
    frontier.read("a");
    setImmediate(() => {
      frontier.read("b");
      setImmediate(() => frontier.read("c"));
    });

    expect(await frontier.settled()).toBe(true);
  });
});
