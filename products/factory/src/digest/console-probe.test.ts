import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { alarmLinks, httpsProbe } from "./console-probe.js";

const ORIGIN = "https://console.example.ts.net";

describe("alarmLinks", () => {
  it("keeps an origin whose root answers 401, probing it once", async () => {
    const urls: string[] = [];

    const links = await alarmLinks(ORIGIN, async (url) => (urls.push(url), 401));

    expect(links).toEqual({ origin: ORIGIN });
    expect(urls).toEqual([`${ORIGIN}/`]);
  });

  it("omits links when the origin answers 502", async () => {
    const links = await alarmLinks(ORIGIN, async () => 502);

    expect(links).toEqual({ gap: "digest.consoleOrigin https://console.example.ts.net answered 502, expected 200 or 401: alarm links omitted" });
  });

  it("omits links when the origin does not answer over https", async () => {
    const links = await alarmLinks(ORIGIN, async () => {
      throw new Error("connect ECONNREFUSED");
    });

    expect(links).toMatchObject({ gap: expect.stringContaining("did not answer over https (connect ECONNREFUSED)") });
  });
});

describe("httpsProbe", () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((server) => server.close()));

  /** Announces a 16 KiB TLS record, then sends one byte every 20 ms, so the socket is never idle yet the handshake never finishes. */
  async function dripFeedingServer(): Promise<number> {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.write(Buffer.from([0x16, 0x03, 0x03, 0x40, 0x00]));
      const drip = setInterval(() => socket.write(Buffer.from([0x00])), 20);
      socket.on("close", () => clearInterval(drip));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no tcp port");
    return address.port;
  }

  it("rejects within the total deadline when the server keeps the socket busy without ever answering", async () => {
    const port = await dripFeedingServer();

    await expect(httpsProbe(`https://127.0.0.1:${port}/`, 300)).rejects.toThrow("probe timed out");
  }, 2_000); // the old idle timeout fired only after 5 s, so base overruns this and fails
});
