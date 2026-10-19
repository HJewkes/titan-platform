import { expect, it } from "vitest";
import type { HarnessSourceLookup, HarnessSourcePort } from "@titan-design/agent-protocol/harness";
import type { SessionSourceLookup } from "./claude-source.js";
import { readSessionObservations, readSessionSourceText } from "./session-observations.js";

const operations: Pick<HarnessSourcePort, "readObservations" | "readText"> = {
  readObservations: readSessionObservations,
  readText: readSessionSourceText,
};
function pluralLookup(lookup: SessionSourceLookup): HarnessSourceLookup {
  if (lookup.status === "found") return { status: "found", sources: [lookup.source] };
  if (lookup.status === "not_written") return { status: "not_written", expectedPaths: [lookup.expectedPath] };
  return lookup;
}
it("accepts existing source read functions without changing their signatures", () => {
  expect(operations.readObservations).toBe(readSessionObservations);
  expect(operations.readText).toBe(readSessionSourceText);
});
it("preserves existing Claude not-written and unavailable variants in a plural lookup", () => {
  expect(pluralLookup({ status: "not_written", expectedPath: "/fixture/expected" })).toEqual({ status: "not_written", expectedPaths: ["/fixture/expected"] });
  expect(pluralLookup({ status: "unavailable", reason: "unreadable" })).toEqual({ status: "unavailable", reason: "unreadable" });
});
