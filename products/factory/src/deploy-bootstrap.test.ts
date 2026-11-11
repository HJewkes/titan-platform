import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { serviceRunsFromCheckout } from "./deploy-bootstrap.js";
import { deployedBinPath } from "./deploy-checkout.js";
import type { DeployPorts } from "./deploy.js";

const portsReading = (text: string | undefined, platform: NodeJS.Platform = "darwin"): DeployPorts =>
  partialFake<DeployPorts>({ platform, home: "/h", readFile: () => text });

const CHECKOUT = "/srv/factory";
const BIN = deployedBinPath(CHECKOUT);
const OTHER_START = "ExecStart=/usr/bin/node /srv/other/bin.js serve";

const runsFromCheckout = (unit: string | undefined, checkout = CHECKOUT): boolean =>
  serviceRunsFromCheckout(portsReading(unit, "linux"), checkout);
const serviceUnit = (...lines: string[]): string => `[Service]\n${lines.join("\n")}\n`;

describe("serviceRunsFromCheckout on a plist", () => {
  it("accepts a plist that starts the checkout's own bin", () => {
    expect(serviceRunsFromCheckout(portsReading(`<string>${BIN}</string>`), CHECKOUT)).toBe(true);
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

  it("accepts an XML-escaped bin whose checkout path contains an ampersand", () => {
    const checkout = "/srv/a&b/factory";
    const escaped = deployedBinPath(checkout).replace(/&/g, "&amp;");
    expect(serviceRunsFromCheckout(portsReading(`<string>${escaped}</string>`), checkout)).toBe(true);
  });

  it("rejects a missing service file", () => {
    expect(serviceRunsFromCheckout(portsReading(undefined), CHECKOUT)).toBe(false);
  });
});

describe("serviceRunsFromCheckout on a systemd unit", () => {
  it("accepts an ExecStart that names the bin", () => {
    expect(runsFromCheckout(serviceUnit(`ExecStart=/usr/bin/node ${BIN} serve`))).toBe(true);
  });

  it("accepts the bin as a quoted argument", () => {
    expect(runsFromCheckout(serviceUnit(`ExecStart="${BIN}"`))).toBe(true);
  });

  it("rejects a quoted argument that continues past the bin after a space", () => {
    expect(runsFromCheckout(serviceUnit(`ExecStart=node "${BIN} old"`))).toBe(false);
  });

  it("accepts a continued ExecStart and one with a systemd prefix", () => {
    expect(runsFromCheckout(serviceUnit(`ExecStart=/usr/bin/node \\\n  ${BIN} serve`))).toBe(true);
    expect(runsFromCheckout(serviceUnit(`ExecStart = -${BIN} serve`))).toBe(true);
  });

  it("accepts an ExecStart that names the bin among comment and Environment lines", () => {
    expect(runsFromCheckout(serviceUnit("# note", "Environment=A=b", `ExecStart=/usr/bin/node ${BIN} serve`))).toBe(true);
  });

  it.each([
    ["a commented ExecStart", `#ExecStart=${BIN}`],
    ["a semicolon-commented ExecStart", `  ;ExecStart=${BIN}`],
    ["an Environment line", `Environment=X=${BIN}`],
  ])("rejects a unit whose only mention of the bin is %s", (_label, line) => {
    expect(runsFromCheckout(serviceUnit(line))).toBe(false);
  });

  it.each([
    ["a comment", `# was ${BIN}`],
    ["an Environment line", `Environment=BIN=${BIN}`],
    ["an Environment key with spaces around the equals sign", `Environment = X=${BIN}`],
    ["a continued Environment line", `Environment=A=b \\\n  X=${BIN}`],
    ["a Description", `Description=${BIN}`],
    ["an ExecStartPre", `ExecStartPre=/bin/ls ${BIN}`],
    ["a key with an underscore", `X_Y=${BIN}`],
    ["a key with a dot", `X.Y=${BIN}`],
    ["a key with a leading digit", `1X=${BIN}`],
    ["a bare line", BIN],
  ])("rejects an ExecStart from another tree when %s names the bin", (_label, line) => {
    expect(runsFromCheckout(serviceUnit(line, OTHER_START))).toBe(false);
  });

  it("rejects a bin named only in a CRLF Environment line while another tree starts", () => {
    const unit = serviceUnit(`Environment=X=${BIN}`, OTHER_START).replace(/\n/g, "\r\n");
    expect(runsFromCheckout(unit)).toBe(false);
  });

  it("accepts a CRLF unit whose ExecStart names the bin", () => {
    expect(runsFromCheckout(serviceUnit(`ExecStart=/usr/bin/node ${BIN} serve`).replace(/\n/g, "\r\n"))).toBe(true);
  });

  it("rejects a bin that an empty ExecStart= reset cleared before another tree", () => {
    expect(runsFromCheckout(serviceUnit(`ExecStart=/usr/bin/node ${BIN} serve`, "ExecStart=", OTHER_START))).toBe(false);
  });

  it("accepts a bin set again after an empty ExecStart= reset", () => {
    expect(runsFromCheckout(serviceUnit(OTHER_START, "ExecStart=", `ExecStart=/usr/bin/node ${BIN} serve`))).toBe(true);
  });

  it.each(["[Install]", "[Unit]"])("rejects an ExecStart under %s while [Service] starts another tree", (section) => {
    const unit = `${section}\nExecStart=${BIN}\n\n${serviceUnit(OTHER_START)}`;
    expect(runsFromCheckout(unit)).toBe(false);
  });

  it("rejects a missing unit file", () => {
    expect(runsFromCheckout(undefined)).toBe(false);
  });
});
