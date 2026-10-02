import { describe, expect, it } from "vitest";
import { morningQueueItems, queueAsk } from "./queues.js";

const QUEUE = `# Queue: seat-a

## In flight

1. **T-1** implementer running on acme/widgets#3.

## Morning queue (owner only)

Merges: run the merge helper with the args below.
4. **widgets#11:** \`acme/widgets 11 abc123 ~/src/widgets\`
5. Pick a colour for the badge.

## Overflow offered

6. Nothing here belongs to the owner.
`;

describe("morningQueueItems", () => {
  it("reads only the numbered items under the owner-only heading", () => {
    expect(morningQueueItems(QUEUE)).toEqual(["**widgets#11:** `acme/widgets 11 abc123 ~/src/widgets`", "Pick a colour for the badge."]);
  });

  it("reads nothing from a queue with no owner-only heading", () => {
    expect(morningQueueItems("# Queue\n\n## In flight\n\n1. busy\n")).toEqual([]);
  });
});

describe("queueAsk", () => {
  it("splits the last code span off as the command and keys the PR it names", () => {
    expect(queueAsk("seat-a", "**widgets#11:** `acme/widgets 11 abc123 ~/src/widgets`")).toEqual({
      text: "widgets#11",
      command: "acme/widgets 11 abc123 ~/src/widgets",
      source: "seat-a",
      keys: ["pr:widgets#11"],
    });
  });

  it("shows a command-only item as its command", () => {
    expect(queueAsk("seat-a", "`tool done T-9`")).toEqual({ text: "tool done T-9", source: "seat-a", keys: [] });
  });
});
