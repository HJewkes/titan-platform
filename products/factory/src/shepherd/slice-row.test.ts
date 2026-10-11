import type { JsonEnvelope } from "@titan-design/registry";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture } from "../test-support/shepherd.js";
import { formatShepherd } from "./format.js";
import type { PrTimeline, WatchRow } from "./view.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

async function registeredWorld(slice?: string) {
  const fixture = shepherdFixture({ frozen: true });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  const call = <T>(name: string, args: unknown) => callCommand<T>(host, fixture.routes, name, args);
  const registered = await call("shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a", ...(slice && { slice }) });
  if (!registered.ok) throw new Error(registered.error);
  return call;
}

async function data<T>(envelope: Promise<JsonEnvelope<T>>): Promise<T> {
  const result = await envelope;
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe("a sliced registration", () => {
  it("carries its slice label on the status row", async () => {
    const call = await registeredWorld("a");

    const rows = await data(call<WatchRow[]>("shepherd.status", { repo: REPO, pr: 1 }));

    expect(rows).toMatchObject([{ slice: "a", task: "demo/T-1" }]);
  });

  it("names its task and slice on the timeline header line", async () => {
    const call = await registeredWorld("a");

    const timeline = await data(call<PrTimeline>("shepherd.timeline", { repo: REPO, pr: 1 }));
    const header = formatShepherd("shepherd.timeline", timeline).split("\n")[0];

    expect(header).toMatch(/ task demo\/T-1 slice a$/);
  });
});

describe("a whole-task registration", () => {
  it("reports a null slice and leaves the slice off the timeline header", async () => {
    const call = await registeredWorld();

    const rows = await data(call<WatchRow[]>("shepherd.status", { repo: REPO, pr: 1 }));
    const timeline = await data(call<PrTimeline>("shepherd.timeline", { repo: REPO, pr: 1 }));

    expect(rows).toMatchObject([{ slice: null }]);
    expect(formatShepherd("shepherd.timeline", timeline).split("\n")[0]).toMatch(/ task demo\/T-1$/);
  });
});
