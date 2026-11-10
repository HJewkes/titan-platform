import { describe, expect, it } from "vitest";
import { FakeHttpError } from "./fake.js";
import { WriteRetriesExhaustedError, writeWithReadBack } from "./write-read-back.js";

function harness(failures: number) {
  const waits: number[] = [];
  let writes = 0;
  let probes = 0;
  const write = async () => {
    writes++;
    if (writes <= failures) throw new FakeHttpError(502, "bad gateway");
    return "written";
  };
  const landed = async () => (probes++, undefined);
  const sleep = async (ms: number) => void waits.push(ms);
  return { write, landed, sleep, counts: () => ({ writes, probes, waits }) };
}

describe("writeWithReadBack schedule", () => {
  it("sends one write more than it has delays and throws the last write's own error when the schedule asks for it", async () => {
    const h = harness(10);

    const outcome = writeWithReadBack("post", h.write, h.landed, h.sleep, { delays: [10, 20], attempts: 3, rawError: true });

    await expect(outcome).rejects.toThrow(FakeHttpError);
    expect(h.counts()).toEqual({ writes: 3, probes: 2, waits: [10, 20] });
  });

  it("reads back at once without sleeping on a zero delay", async () => {
    const h = harness(10);

    const outcome = writeWithReadBack("put", h.write, h.landed, h.sleep, { delays: [0], rawError: true });

    await expect(outcome).rejects.toThrow(/502/);
    expect(h.counts()).toEqual({ writes: 1, probes: 1, waits: [] });
  });

  it("wraps the last error with the attempt count by default", async () => {
    const h = harness(10);

    const outcome = writeWithReadBack("put", h.write, h.landed, h.sleep, { delays: [5] });

    await expect(outcome).rejects.toBeInstanceOf(WriteRetriesExhaustedError);
    await expect(outcome).rejects.toThrow(/put failed after 1 attempts/);
    expect(h.counts()).toEqual({ writes: 1, probes: 1, waits: [5] });
  });
});
