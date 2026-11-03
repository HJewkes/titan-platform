import { describe, expect, it } from "vitest";
import { EventBook } from "./events.js";
import { EventFollower, REPLAY_ROWS } from "./stream.js";

const reset = (latestId: number) => ({ event: "reset", data: JSON.stringify({ reason: "gap_too_large", latestId }) });

describe("EventFollower", () => {
  it("answers the first reset by reconnecting to replay the newest rows", () => {
    const follower = new EventFollower(new EventBook());

    expect(follower.frame(reset(5_000))).toBe("restart");
    expect(follower.since).toBe(5_000 - REPLAY_ROWS);
  });

  it("only moves the cursor on a later reset", () => {
    const follower = new EventFollower(new EventBook());
    follower.frame(reset(5_000));

    expect(follower.frame(reset(9_000))).toBe("changed");
    expect(follower.since).toBe(9_000);
  });

  it("replays from the start of a log shorter than the replay window", () => {
    const follower = new EventFollower(new EventBook());

    follower.frame(reset(120));

    expect(follower.since).toBe(0);
  });
});
