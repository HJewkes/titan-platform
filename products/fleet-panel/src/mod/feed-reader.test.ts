import { describe, expect, it } from "vitest";
import { fixtureSnapshot } from "../fixture.js";
import { FeedReader } from "./feed-reader.js";

describe("FeedReader", () => {
  it("takes a snapshot line however the pipe cuts it", () => {
    const reader = new FeedReader();
    const line = `${JSON.stringify(fixtureSnapshot())}\n`;

    expect(reader.stdout(line.slice(0, 50))).toBe(false);
    expect(reader.stdout(line.slice(50))).toBe(true);

    expect(reader.snapshot?.agents).toHaveLength(4);
  });

  it("names the feed's last stderr line when it exits", () => {
    const reader = new FeedReader();
    reader.stderrText("warming up\nError: spawn agent-chat ENOENT\n");

    reader.exited("exited");

    expect(reader.problem).toBe("the feed exited: Error: spawn agent-chat ENOENT");
  });

  it("strips control characters from the feed's stderr before showing it", () => {
    const reader = new FeedReader();
    reader.stderrText("Error: \u001b]0;retitled\u0007bad \u009b2Jthing\n");

    reader.exited("exited");

    expect(reader.problem).toBe("the feed exited: Error: ]0;retitledbad 2Jthing");
  });

  it("keeps the last snapshot when a line is not one", () => {
    const reader = new FeedReader();
    reader.stdout(`${JSON.stringify(fixtureSnapshot())}\n`);

    reader.stdout("oops\n");

    expect(reader.snapshot).not.toBeNull();
    expect(reader.problem).toMatch(/not a snapshot: oops/);
  });
});
