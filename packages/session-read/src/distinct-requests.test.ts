import { describe, expect, it } from "vitest";
import { distinctRequests, type TranscriptRequest } from "./distinct-requests.js";

const request = (requestId: string, outputTokens: number): TranscriptRequest => ({ requestId, outputTokens }) as TranscriptRequest;

describe("distinctRequests", () => {
  it("keeps the last line of a response split over several lines", () => {
    const result = distinctRequests([request("a", 1), request("a", 5)]);

    expect(result).toEqual([request("a", 5)]);
  });

  it("keeps distinct responses in the order each id first appeared", () => {
    const result = distinctRequests([request("a", 1), request("b", 2), request("a", 3)]);

    expect(result.map((r) => [r.requestId, r.outputTokens])).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
  });

  it("returns nothing for no requests", () => {
    expect(distinctRequests([])).toEqual([]);
  });
});
