import type { ArPorts } from "@titan-design/autoresearch";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { arRoutes } from "./routes.js";
import { autoresearchWorkflow } from "./workflow.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function portsFailingAtPin(): ArPorts {
  const unused = () => Promise.reject(new Error("not reached"));
  return {
    pin: () => Promise.reject(new Error("target.json missing at the pin")),
    plan: unused,
    allocTree: unused,
    implement: unused,
    staticCheck: unused,
    micro: unused,
    evalCase: unused,
    ratchet: unused,
    releaseTree: unused,
    now: () => Date.parse("2026-10-21T00:00:00Z"),
  };
}

describe("autoresearch on the factory host", () => {
  it("routes every dispatch step of the package's workflow and fails the run on a port error", async () => {
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [autoresearchWorkflow()], routes: arRoutes(portsFailingAtPin()), gatePollMs: 5 });
    hosts.push(host);

    const run = await host.runtime.wait(host.runtime.start("autoresearch", { pin: "abc123" }));

    expect(run.status).toBe("failed");
    expect(run.error).toContain("target.json missing at the pin");
  });
});
