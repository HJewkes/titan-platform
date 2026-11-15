import { describe, expect, it } from "vitest";
import { replayPlaybook, type DrainOccurrence } from "./replay.js";

const WINDOW = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" };

function occ(templateId: string, sessionId: string, day: number, maskedSignature: string): DrainOccurrence {
  return { templateId, sessionId, ts: `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`, maskedSignature };
}

const SIGNATURE = "ECONNRESET socket hangup while fetching upstream registry";

function cluster(templateId: string, days: number[], signature = SIGNATURE): DrainOccurrence[] {
  return days.map((d) => occ(templateId, `${templateId}-s${d}`, d, signature));
}

function queries(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("replayPlaybook", () => {
  it("excludes a cluster with only two occurrences", async () => {
    const result = await replayPlaybook({ occurrences: cluster("t1", [3, 5]), openingQueries: new Map(), window: WINDOW, k: 3 });

    expect(result.clusters).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it("excludes occurrences outside the window, which can drop a cluster below three", async () => {
    const occurrences = [...cluster("t1", [3, 5]), occ("t1", "t1-late", 28, SIGNATURE), { ...occ("t1", "t1-old", 1, SIGNATURE), ts: "2026-09-20T10:00:00.000Z" }];

    const inWindow = await replayPlaybook({ occurrences, openingQueries: new Map(), window: { from: WINDOW.from, to: "2026-10-20T00:00:00.000Z" }, k: 3 });
    const wide = await replayPlaybook({ occurrences, openingQueries: new Map(), window: WINDOW, k: 3 });

    expect(inWindow.clusters).toBe(0);
    expect(wide.rows[0]?.occurrences).toBe(3);
  });

  it("counts a later session whose opening query shares tokens with the signature as served", async () => {
    const result = await replayPlaybook({
      occurrences: cluster("t1", [3, 5, 9]),
      openingQueries: queries({ "t1-s5": "fix registry fetch socket hangup", "t1-s9": "registry fetch flaky" }),
      window: WINDOW,
      k: 3,
    });

    expect(result.rows).toEqual([{ templateId: "t1", occurrences: 3, laterOccurrences: 2, servedBefore: 2 }]);
    expect(result.servedRate).toBe(1);
  });

  it("does not count a later session whose opening query shares no tokens", async () => {
    const result = await replayPlaybook({
      occurrences: cluster("t1", [3, 5, 9]),
      openingQueries: queries({ "t1-s5": "fix registry fetch socket hangup", "t1-s9": "rename dashboard widgets" }),
      window: WINDOW,
      k: 3,
    });

    expect(result.servedBefore).toBe(1);
    expect(result.laterOccurrences).toBe(2);
    expect(result.servedRate).toBe(0.5);
  });

  it("never serves a bullet to an occurrence earlier than its seed", async () => {
    const shuffled = [occ("t1", "t1-s9", 9, SIGNATURE), occ("t1", "t1-s3", 3, SIGNATURE), occ("t1", "t1-s5", 5, SIGNATURE)];
    const result = await replayPlaybook({
      occurrences: shuffled,
      openingQueries: queries({ "t1-s3": "registry fetch socket hangup", "t1-s5": "registry fetch socket hangup", "t1-s9": "registry fetch socket hangup" }),
      window: WINDOW,
      k: 3,
    });

    expect(result.rows[0]?.laterOccurrences).toBe(2);
    expect(result.servedBefore).toBe(2);
  });

  it("serves only bullets that rank within the top k", async () => {
    const occurrences = [...cluster("t1", [3, 5, 9]), ...cluster("t2", [2, 4, 6], "ECONNRESET socket hangup elsewhere")];
    const q = "socket hangup ECONNRESET";
    const openingQueries = queries({ "t1-s5": q, "t1-s9": q, "t2-s4": q, "t2-s6": q });

    const tight = await replayPlaybook({ occurrences, openingQueries, window: WINDOW, k: 1 });
    const loose = await replayPlaybook({ occurrences, openingQueries, window: WINDOW, k: 5 });

    expect(loose.servedBefore).toBe(4);
    expect(tight.servedBefore).toBeLessThan(loose.servedBefore);
  });

  it("reports the share of in-window occurrences that repeat an earlier one as the baseline", async () => {
    const occurrences = [...cluster("t1", [3, 5, 9]), occ("t9", "t9-s1", 4, "unrelated singleton")];
    const result = await replayPlaybook({ occurrences, openingQueries: new Map(), window: WINDOW, k: 3 });

    expect(result.baselineRepeatRate).toBe(2 / 4);
  });

  describe("when one session holds several occurrences of a template", () => {
    const later = (o: DrainOccurrence, hour: number): DrainOccurrence => ({ ...o, ts: o.ts.replace("T10", `T${hour}`) });
    const retries = (sessionId: string, day: number): DrainOccurrence[] => [10, 11, 12].map((h) => later(occ("t1", sessionId, day, SIGNATURE), h));

    it("does not treat a retry loop in a single session as a recurring cluster", async () => {
      const result = await replayPlaybook({ occurrences: retries("only", 3), openingQueries: new Map(), window: WINDOW, k: 3 });

      expect(result.clusters).toBe(0);
    });

    it("counts each later session once and skips repeats in the seed's own session", async () => {
      const occurrences = [...retries("t1-s3", 3), ...retries("t1-s5", 5), occ("t1", "t1-s9", 9, SIGNATURE)];
      const q = "registry fetch socket hangup";
      const result = await replayPlaybook({ occurrences, openingQueries: queries({ "t1-s3": q, "t1-s5": q, "t1-s9": q }), window: WINDOW, k: 3 });

      expect(result.rows).toEqual([{ templateId: "t1", occurrences: 3, laterOccurrences: 2, servedBefore: 2 }]);
      expect(result.baselineRepeatRate).toBe(2 / 3);
    });
  });
});
