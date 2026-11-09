import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { serviceRunsFromCheckout } from "./deploy-bootstrap.js";
import { deployedBinPath } from "./deploy-checkout.js";
import type { DeployPorts } from "./deploy.js";

const portsReading = (text: string | undefined): DeployPorts =>
  partialFake<DeployPorts>({ platform: "darwin", home: "/h", readFile: () => text });

const CHECKOUT = "/srv/factory";
const BIN = deployedBinPath(CHECKOUT);

describe("serviceRunsFromCheckout", () => {
  it("accepts a plist that starts the checkout's own bin", () => {
    expect(serviceRunsFromCheckout(portsReading(`<string>${BIN}</string>`), CHECKOUT)).toBe(true);
  });

  it("accepts a systemd unit whose ExecStart names the bin", () => {
    expect(serviceRunsFromCheckout(portsReading(`ExecStart=/usr/bin/node ${BIN} serve`), CHECKOUT)).toBe(true);
  });

  it("rejects a bin nested under another directory that ends with the checkout path", () => {
    const nested = `/x${BIN}`;
    expect(serviceRunsFromCheckout(portsReading(`<string>${nested}</string>`), CHECKOUT)).toBe(false);
  });

  it.each([
    ["a suffixed file", `${BIN}.bak`],
    ["a longer name", `${BIN}x`],
    ["a plus-prefixed path", `/a+${BIN}`],
    ["a non-ASCII-prefixed path", `/é${BIN}`],
    ["a non-ASCII-suffixed path", `${BIN}é`],
    ["a plus-suffixed path", `${BIN}+old`],
    ["a version-suffixed path", `${BIN}@1`],
    ["a comma-suffixed path", `${BIN},v`],
    ["an XML-escaped ampersand suffix", `${BIN}&amp;x`],
  ])("rejects %s", (_label, path) => {
    expect(serviceRunsFromCheckout(portsReading(`<string>${path}</string>`), CHECKOUT)).toBe(false);
  });

  it("rejects a quoted argument that continues past the bin after a space", () => {
    expect(serviceRunsFromCheckout(portsReading(`ExecStart=node "${BIN} old"`), CHECKOUT)).toBe(false);
  });

  it("accepts the bin as a quoted or XML-escaped argument", () => {
    expect(serviceRunsFromCheckout(portsReading(`ExecStart="${BIN}"`), CHECKOUT)).toBe(true);
    expect(serviceRunsFromCheckout(portsReading(`<string>${BIN.replace(/&/g, "&amp;")}</string>`), CHECKOUT)).toBe(true);
  });

  it("rejects a missing service file", () => {
    expect(serviceRunsFromCheckout(portsReading(undefined), CHECKOUT)).toBe(false);
  });
});
