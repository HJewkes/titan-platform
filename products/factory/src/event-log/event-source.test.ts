import { describe, expect, it } from "vitest";
import type { EventSource } from "./event-log.js";

describe("EventSource", () => {
  it("admits the five sources and rejects the Events API", () => {
    const admitted: EventSource[] = ["webhook", "backstop", "store", "broker", "merge-log"];
    // @ts-expect-error the Activity Events API is never a source
    const rejected: EventSource = "events-api";

    expect(admitted).toHaveLength(5);
    expect(rejected).toBe("events-api");
  });
});
