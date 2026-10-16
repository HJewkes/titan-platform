import { githubPort, type GitHubPort, type PrFile } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture, type FixtureOptions, type ShepherdFixture } from "../test-support/shepherd.js";
import type { Registered } from "./commands.js";
import { sizeFlagFor } from "./size-flag.js";
import type { Registration } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World extends ShepherdFixture {
  register: (args: object) => Promise<Registered>;
}

function world(options: FixtureOptions = {}): World {
  const fixture = shepherdFixture({ frozen: true, ...options });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  const register = async (args: object) => {
    const envelope = await callCommand<Registered>(host, fixture.routes, "shepherd.register", args);
    if (!envelope.ok) throw new Error(envelope.error);
    return envelope.data;
  };
  return { ...fixture, register };
}

const pr1 = { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" };
const file = (path: string, additions: number): PrFile => ({ path, status: "modified", additions, deletions: 0 });

describe("shepherd register flags an oversize security slice", () => {
  it("flags a kind security PR over 400 non-generated lines", async () => {
    const w = world();
    w.fake.prFiles.set(1, [file("src/parser.ts", 420), file("pnpm-lock.yaml", 0)]);

    const result = await w.register({ ...pr1, kind: "security" });

    expect(result.sizeFlag).toEqual({ lines: 420, cap: 400, guardPaths: [] });
  });

  it("flags a guard-area PR over the cap whatever its kind", async () => {
    const w = world();
    w.fake.prFiles.set(1, [file("packages/tool-guard/src/x.ts", 401)]);

    const result = await w.register({ ...pr1, kind: "feature" });

    expect(result.sizeFlag).toEqual({ lines: 401, cap: 400, guardPaths: ["packages/tool-guard/src/x.ts"] });
  });

  it("leaves a non-guard correctness PR unflagged however large", async () => {
    const w = world();
    w.fake.prFiles.set(1, [file("src/parser.ts", 900)]);

    const result = await w.register({ ...pr1, kind: "correctness" });

    expect(result).not.toHaveProperty("sizeFlag");
  });

  it("still registers, unflagged, when the file list cannot be read", async () => {
    const source = world();
    const failing: GitHubPort = { ...githubPort(source.fake.wire), listPrFiles: () => Promise.reject(new Error("gh outage")) };
    const shaky = world({ port: failing });

    const result = await shaky.register({ ...pr1, kind: "security" });

    expect(result.created).toBe(true);
    expect(result).not.toHaveProperty("sizeFlag");
  });
});

describe("sizeFlagFor", () => {
  const registration = partialFake<Registration>({ repo: REPO, pr: 1, kind: "security", headSha: null, base: null });

  it("gives no flag when the read outlasts its timeout", async () => {
    const port = partialFake<GitHubPort>({ listPrFiles: () => new Promise<PrFile[]>(() => {}) });

    expect(await sizeFlagFor(port, registration, { timeoutMs: 5 })).toBeUndefined();
  });

  it("gives no flag for a file with no line counts", async () => {
    const port = partialFake<GitHubPort>({ listPrFiles: async () => [{ path: "src/a.ts", status: "modified" }, file("src/b.ts", 900)] });

    expect(await sizeFlagFor(port, registration)).toBeUndefined();
  });

  it("gives no flag for a branch registration with no PR yet", async () => {
    const port = partialFake<GitHubPort>({ listPrFiles: () => Promise.reject(new Error("never called")) });

    expect(await sizeFlagFor(port, { ...registration, pr: null })).toBeUndefined();
  });
});
