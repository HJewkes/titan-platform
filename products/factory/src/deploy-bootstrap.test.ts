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

  it("rejects a missing service file", () => {
    expect(serviceRunsFromCheckout(portsReading(undefined), CHECKOUT)).toBe(false);
  });
});
