import { describe, expect, it } from "vitest";
import { inboxLink, inboxLinkArgs } from "./cli-inbox-link.js";
import { resolveConfig, type Machine } from "./config.js";

const HOME = "/srv/tester";
const LAN_IP = "192.0.2.10";
const TLS = { TITAN_CONSOLE_TLS_CERT: "~/tls/box.example.ts.net.crt", TITAN_CONSOLE_TLS_KEY: "~/tls/box.example.ts.net.key" };
const machine: Machine = { hostname: () => "Lan-Box", addresses: () => [LAN_IP] };
const config = (env: NodeJS.ProcessEnv) => resolveConfig({ TITAN_CONSOLE_STATE: "/state", ...env }, HOME, "linux", machine);
const GATE = "gate:0f1e2d3c-4b5a-4968-8776-655443322110/approve-merge";

describe("titan-console inbox link", () => {
  it("prints an https link on the first LAN name and the console's port, with the whole gate id as one segment", () => {
    const lan = config({ TITAN_CONSOLE_HOST: LAN_IP, TITAN_CONSOLE_LAN_NAMES: "box.example.ts.net,box.local", TITAN_CONSOLE_PORT: "7510", ...TLS });

    expect(inboxLink(lan, GATE)).toBe("https://box.example.ts.net:7510/#/inbox/gate%3A0f1e2d3c-4b5a-4968-8776-655443322110%2Fapprove-merge");
  });

  it("names this machine's hostname when no LAN names are set but the LAN listener is on", () => {
    expect(inboxLink(config({ TITAN_CONSOLE_HOST: LAN_IP, ...TLS }), "round:ship-tile-r1")).toBe("https://lan-box:7500/#/inbox/round%3Aship-tile-r1");
  });

  it("falls back to loopback only for a console with no LAN listener", () => {
    const deposit = `deposit:${"a1".repeat(16)}`;

    expect(inboxLink(config({ TITAN_CONSOLE_LAN_NAMES: "box.example.ts.net" }), deposit)).toBe(`http://127.0.0.1:7500/#/inbox/deposit%3A${"a1".repeat(16)}`);
  });

  it("refuses a console on an ephemeral port, which has no port to put in a link", () => {
    expect(() => inboxLink(config({ TITAN_CONSOLE_PORT: "0" }), GATE)).toThrow(/TITAN_CONSOLE_PORT is 0/);
  });

  it("takes exactly one item id after inbox link", () => {
    expect(inboxLinkArgs(["inbox", "link", GATE])).toEqual({ id: GATE });
    expect(inboxLinkArgs(["inbox", "link"])).toBeNull();
    expect(inboxLinkArgs(["inbox", "link", GATE, "extra"])).toBeNull();
    expect(inboxLinkArgs(["inbox", "link", "--json"])).toBeNull();
    expect(inboxLinkArgs(["rounds", "link", GATE])).toBeNull();
  });
});
