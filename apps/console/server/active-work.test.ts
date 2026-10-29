import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { successEnvelope } from "@titan-design/registry";
import { activeWorkClient } from "./active-work.js";
import type { UpstreamSample } from "./perf/recorder.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

let daemon: FakeDaemon | undefined;
let hung: Server | undefined;
afterEach(async () => {
  await daemon?.close();
  hung?.closeAllConnections();
  hung?.close();
  daemon = undefined;
  hung = undefined;
});

function collector() {
  const samples: UpstreamSample[] = [];
  return { samples, recordUpstream: (sample: UpstreamSample) => void samples.push(sample) };
}

async function listenNeverAnswering(): Promise<number> {
  hung = createServer(() => {});
  await new Promise<void>((resolve) => hung!.listen(0, "127.0.0.1", resolve));
  const address = hung.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("active-work upstream timing", () => {
  it("a read past its timeout is recorded as outcome timeout with the command name", async () => {
    const recorder = collector();
    const client = activeWorkClient(await listenNeverAnswering(), 50, recorder);

    await expect(client.read("loops", { slug: "synthetic-initiative" })).rejects.toThrow();

    expect(recorder.samples).toEqual([expect.objectContaining({ name: "active-work:loops", outcome: "timeout" })]);
  });

  it("an answered read is recorded as ok with the byte length of the body and no argument value", async () => {
    const body = JSON.stringify(successEnvelope({ open: [] }));
    daemon = await startFakeDaemon({ ok: true }, () => ({ open: [] }));
    const recorder = collector();

    await activeWorkClient(daemon.port, 5000, recorder).read("loops", { slug: "synthetic-initiative" });

    await vi.waitFor(() => expect(recorder.samples).toHaveLength(1));
    expect(recorder.samples[0]).toMatchObject({ name: "active-work:loops", outcome: "ok", bytes: Buffer.byteLength(body) });
    expect(JSON.stringify(recorder.samples)).not.toContain("synthetic-initiative");
  });

  it("a recorder that throws never changes the read's answer", async () => {
    daemon = await startFakeDaemon({ ok: true }, () => ({ open: [] }));
    const recorder = {
      recordUpstream: () => {
        throw new Error("disk full");
      },
    };

    await expect(activeWorkClient(daemon.port, 5000, recorder).read("loops", {})).resolves.toEqual({ open: [] });
  });
});
