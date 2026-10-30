import type { ExtractResult } from "./read.js";

export type TranscriptRequest = ExtractResult["requests"][number];

/** A response split over several transcript lines repeats its usage on each, so it counts once; the last line wins, in input order. */
export function distinctRequests<T extends { requestId: string }>(requests: readonly T[]): T[] {
  return [...new Map(requests.map((request) => [request.requestId, request])).values()];
}
