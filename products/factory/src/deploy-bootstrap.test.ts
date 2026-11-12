import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { serviceRunsFromCheckout } from "./deploy-bootstrap.js";
import { deployedBinPath } from "./deploy-checkout.js";
import type { DeployPorts } from "./deploy.js";
import type { CommandResult } from "./run-command.js";

const CHECKOUT = "/srv/factory";
const BIN = deployedBinPath(CHECKOUT);
const NODE = "/opt/node/bin/node";

const answer = (stdout: string, code = 0, stderr = ""): CommandResult => ({ code, stdout, stderr });

/** The shape `systemctl --user show titan-factory.service --property=LoadState,ExecStart` prints on the service host, with synthetic paths. */
const shown = (argv: string, loadState = "loaded"): string =>
  `LoadState=${loadState}\nExecStart={ path=${NODE} ; argv[]=${argv} ; ignore_errors=no ; start_time=[Tue 2026-01-06 10:00:00 UTC] ; stop_time=[n/a] ; pid=4242 ; code=(null) ; status=0/0 }\n`;

/** The documented `launchctl print gui/<uid>/<label>` layout: one unescaped argument per line. */
const printed = (...args: string[]): string =>
  `gui/501/test.factory = {\n\tactive count = 1\n\tpath = /srv/test.plist\n\ttype = LaunchAgent\n\tstate = running\n\n\targuments = {\n${args.map((arg) => `\t\t${arg}\n`).join("")}\t}\n\n\tpid = 4242\n}\n`;

interface Seen {
  systemctl: string[][];
  launchctl: string[][];
}

function linuxPorts(reply: CommandResult, seen: Seen = { systemctl: [], launchctl: [] }, fileText?: string): DeployPorts {
  return partialFake<DeployPorts>({
    platform: "linux",
    home: "/h",
    systemctl: async (args) => {
      seen.systemctl.push([...args]);
      return reply;
    },
    readFile: () => fileText,
  });
}

function darwinPorts(reply: CommandResult, fileText?: string): DeployPorts {
  return partialFake<DeployPorts>({ platform: "darwin", uid: 501, home: "/h", launchctl: async () => reply, readFile: () => fileText });
}

describe("serviceRunsFromCheckout on systemd", () => {
  it("accepts a loaded unit whose ExecStart runs the checkout's bin", async () => {
    const ports = linuxPorts(answer(shown(`${NODE} ${BIN} serve --port 7420`)));

    expect(await serviceRunsFromCheckout(ports, CHECKOUT)).toBe(true);
  });

  it("rejects a unit whose ExecStart runs another tree", async () => {
    const ports = linuxPorts(answer(shown(`${NODE} /srv/other/products/factory/dist/bin.js serve`)));

    expect(await serviceRunsFromCheckout(ports, CHECKOUT)).toBe(false);
  });

  it("rejects the bin named as a later argument, not the script", async () => {
    const ports = linuxPorts(answer(shown(`${NODE} /srv/other/bin.js --x ${BIN}`)));

    expect(await serviceRunsFromCheckout(ports, CHECKOUT)).toBe(false);
  });

  it("rejects a unit systemd has not loaded", async () => {
    const ports = linuxPorts(answer(shown(`${NODE} ${BIN} serve`, "not-found")));

    expect(await serviceRunsFromCheckout(ports, CHECKOUT)).toBe(false);
  });

  it("rejects when systemctl cannot answer", async () => {
    const ports = linuxPorts(answer("", 1, "Failed to connect to bus"));

    expect(await serviceRunsFromCheckout(ports, CHECKOUT)).toBe(false);
  });

  it("rejects an ExecStart with more than one command or none", async () => {
    const record = `{ path=${NODE} ; argv[]=${NODE} ${BIN} serve ; ignore_errors=no ; code=(null) ; status=0/0 }`;

    expect(await serviceRunsFromCheckout(linuxPorts(answer(`LoadState=loaded\nExecStart=${record} ${record}\n`)), CHECKOUT)).toBe(false);
    expect(await serviceRunsFromCheckout(linuxPorts(answer("LoadState=loaded\nExecStart=\n")), CHECKOUT)).toBe(false);
  });

  it("rejects a checkout whose bin path contains a space", async () => {
    const spaced = "/srv/my factory";
    const ports = linuxPorts(answer(shown(`${NODE} ${deployedBinPath(spaced)} serve`)));

    expect(await serviceRunsFromCheckout(ports, spaced)).toBe(false);
  });

  it("asks systemd for the loaded unit, not the file", async () => {
    const seen: Seen = { systemctl: [], launchctl: [] };
    const ports = linuxPorts(answer(shown(`${NODE} /srv/other/bin.js serve`)), seen, `ExecStart=${NODE} ${BIN} serve`);

    expect(await serviceRunsFromCheckout(ports, CHECKOUT)).toBe(false);
    expect(seen.systemctl).toEqual([["--user", "show", "titan-factory.service", "--property=LoadState,ExecStart"]]);
  });
});

describe("serviceRunsFromCheckout on launchd", () => {
  it("accepts a loaded job whose arguments run the checkout's bin", async () => {
    expect(await serviceRunsFromCheckout(darwinPorts(answer(printed(NODE, BIN, "serve"))), CHECKOUT)).toBe(true);
  });

  it("accepts a bin under a checkout path with a space and an ampersand", async () => {
    const odd = "/srv/Application Support/a&b/factory";

    expect(await serviceRunsFromCheckout(darwinPorts(answer(printed(NODE, deployedBinPath(odd), "serve"))), odd)).toBe(true);
  });

  it("rejects a job whose arguments run another tree while the plist on disk names the bin", async () => {
    const ports = darwinPorts(answer(printed(NODE, "/srv/other/bin.js", "serve")), `<string>${BIN}</string>`);

    expect(await serviceRunsFromCheckout(ports, CHECKOUT)).toBe(false);
  });

  it.each([
    ["a nested bin", `/x${BIN}`],
    ["a suffixed bin", `${BIN}.old`],
  ])("rejects %s", async (_label, script) => {
    expect(await serviceRunsFromCheckout(darwinPorts(answer(printed(NODE, script, "serve"))), CHECKOUT)).toBe(false);
  });

  it("rejects when launchctl print fails because the job is not loaded", async () => {
    expect(await serviceRunsFromCheckout(darwinPorts(answer("", 113, "Could not find service")), CHECKOUT)).toBe(false);
  });
});
