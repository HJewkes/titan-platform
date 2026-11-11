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
  });

  it("accepts an XML-escaped bin whose checkout path contains an ampersand", () => {
    const checkout = "/srv/a&b/factory";
    const escaped = deployedBinPath(checkout).replace(/&/g, "&amp;");
    expect(serviceRunsFromCheckout(portsReading(`<string>${escaped}</string>`), checkout)).toBe(true);
  });

  it.each([
    ["a commented ExecStart", `#ExecStart=${BIN}`],
    ["a semicolon-commented ExecStart", `  ;ExecStart=${BIN}`],
    ["an Environment line", `Environment=X=${BIN}`],
  ])("rejects a unit whose only mention of the bin is %s", (_label, line) => {
    expect(serviceRunsFromCheckout(portsReading(line), CHECKOUT)).toBe(false);
  });

  it.each([
    ["a comment", `# was ${BIN}`],
    ["an Environment line", `Environment=BIN=${BIN}`],
  ])("rejects an ExecStart from another tree when %s names the bin", (_label, line) => {
    const unit = `[Service]\n${line}\nExecStart=/usr/bin/node /srv/other/bin.js serve\n`;
    expect(serviceRunsFromCheckout(portsReading(unit), CHECKOUT)).toBe(false);
  });

  it.each([
    ["an Environment key with spaces around the equals sign", `Environment = X=${BIN}`],
    ["a continued Environment line", `Environment=A=b \\\n  X=${BIN}`],
    ["a Description", `Description=${BIN}`],
    ["an ExecStartPre", `ExecStartPre=/bin/ls ${BIN}`],
  ])("rejects an ExecStart from another tree when %s names the bin", (_label, line) => {
    const unit = `[Service]\n${line}\nExecStart=/usr/bin/node /srv/other/bin.js serve\n`;
    expect(serviceRunsFromCheckout(portsReading(unit), CHECKOUT)).toBe(false);
  });

  it("accepts a continued ExecStart and one with a systemd prefix", () => {
    expect(serviceRunsFromCheckout(portsReading(`ExecStart=/usr/bin/node \\\n  ${BIN} serve`), CHECKOUT)).toBe(true);
    expect(serviceRunsFromCheckout(portsReading(`ExecStart = -${BIN} serve`), CHECKOUT)).toBe(true);
  });

  it("accepts an ExecStart that names the bin among comment and Environment lines", () => {
    const unit = `# note\nEnvironment=A=b\nExecStart=/usr/bin/node ${BIN} serve\n`;
    expect(serviceRunsFromCheckout(portsReading(unit), CHECKOUT)).toBe(true);
  });

  it("rejects a missing service file", () => {
    expect(serviceRunsFromCheckout(portsReading(undefined), CHECKOUT)).toBe(false);
  });
});
