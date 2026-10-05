import { describe, expect, it } from "vitest";
import { ReviewerBrokerBusy, notStarted, startedSession, whileBrokerBusy } from "./review-wait.js";

const LEAKY = "refused at https://db.example.invalid/x with tok_FAKE0000SECRET";
const leaks = (text: string) => text.includes("db.example.invalid") || text.includes("tok_FAKE0000SECRET");

describe("what a busy or unreadable broker leaves in a step output", () => {
  it("keeps neither a URL nor a token from a busy refusal in the waits or the not-started reason", async () => {
    let now = 0;
    const timing = { now: () => now, sleep: async (ms: number) => void (now += ms), busyWaitMs: 2 * 60_000 };
    const waits: string[] = [];

    const refusal = await whileBrokerBusy(timing, new AbortController().signal, (text) => void waits.push(text), () => Promise.reject(new ReviewerBrokerBusy(LEAKY))).catch((error: unknown) => error);
    const result = notStarted(refusal, waits);

    expect(result).toEqual({ kind: "none", reason: "the reviewer dispatch was refused: ReviewerBrokerBusy (still refused after 2 min)", notStarted: true, busyWaits: ["ReviewerBrokerBusy; asking again in 1 min", "ReviewerBrokerBusy; asking again in 1 min"] });
    expect(leaks(JSON.stringify(result))).toBe(false);
  });

  it("keeps only the HTTP status or class of a failed roster read", async () => {
    let reads = 0;
    const roster = async (): Promise<{ sessionId: string }[]> => {
      reads += 1;
      throw Object.assign(new Error(LEAKY), { status: 502 });
    };
    const timing = { now: () => reads * 1_000, sleep: async () => undefined, timeoutMs: 1_500, pollMs: 1 };

    const started = await startedSession(roster, () => true, timing, new AbortController().signal);

    expect(started).toEqual({ rosterError: "HTTP 502" });
  });
});
