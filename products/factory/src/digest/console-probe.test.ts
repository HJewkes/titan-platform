import { describe, expect, it } from "vitest";
import { alarmLinks } from "./console-probe.js";

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
