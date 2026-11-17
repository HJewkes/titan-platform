import { describe, expect, it } from "vitest";
import type { UpstreamSample } from "./recorder.js";
import { timedCall } from "./timed-call.js";

function recorded() {
  const samples: UpstreamSample[] = [];
  return { samples, recorder: { recordUpstream: (sample: UpstreamSample) => void samples.push(sample) } };
}

const measured = (out: string | null) => ({ bytes: out?.length ?? 0, ok: out !== null });

describe("timedCall", () => {
  it("a call that answers nothing is recorded as outcome error, and its caller still gets the answer", async () => {
    const { samples, recorder } = recorded();

    const answer = await timedCall(recorder, "git:log", () => Promise.resolve(null), measured);

    expect(answer).toBeNull();
    expect(samples).toEqual([expect.objectContaining({ name: "git:log", outcome: "error", bytes: 0 })]);
  });

  it("a rejected call is recorded as outcome error and still rejects its caller", async () => {
    const { samples, recorder } = recorded();

    await expect(timedCall(recorder, "github:listOpenPrs", () => Promise.reject(new Error("gh down")), () => ({ bytes: 0, ok: true }))).rejects.toThrow("gh down");

    expect(samples).toEqual([expect.objectContaining({ name: "github:listOpenPrs", outcome: "error" })]);
  });

  it("a recorder that throws never fails the call", async () => {
    const recorder = { recordUpstream: () => { throw new Error("disk full"); } };

    expect(await timedCall(recorder, "git:log", () => Promise.resolve("abc"), measured)).toBe("abc");
  });
});
