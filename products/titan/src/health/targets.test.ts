import { describe, expect, it } from "vitest";
import { loadTargets } from "./targets.js";

const home = "/srv/sampler";

function load(hostJson: string | undefined) {
  const warnings: string[] = [];
  const targets = loadTargets({
    env: {},
    home,
    readFile: (path) => {
      if (hostJson === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return hostJson;
    },
    warn: (line) => warnings.push(line),
  });
  return { targets, warnings };
}

describe("loadTargets", () => {
  it("probes the factory on its loopback port with identity from its pid file when host.json is absent", () => {
    const { targets, warnings } = load(undefined);

    expect(targets).toEqual([
      expect.objectContaining({
        name: "factory",
        url: "http://127.0.0.1:7410/health",
        timeoutMs: 5000,
        expectPort: 7410,
        pidStateDir: `${home}/.local/state/titan-factory`,
        observe: expect.arrayContaining(["restartCount", "uncleanStartsTotal", "restartsToday", "build.sha"]),
      }),
    ]);
    expect(warnings).toEqual([]);
  });

  it("lets host.json override the factory URL by name and keeps the other defaults", () => {
    const { targets } = load(JSON.stringify({ health: { targets: [{ name: "factory", url: "http://127.0.0.1:9999/health" }] } }));

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ name: "factory", url: "http://127.0.0.1:9999/health", expectPort: 7410, timeoutMs: 5000 });
  });

  it("adds a host.json target whose name is new", () => {
    const { targets } = load(JSON.stringify({ health: { targets: [{ name: "relay", url: "http://127.0.0.1:7500/health" }] } }));

    expect(targets.map((t) => t.name)).toEqual(["factory", "relay"]);
    expect(targets[1]).toMatchObject({ url: "http://127.0.0.1:7500/health", timeoutMs: 5000 });
  });

  it("leaves the defaults and warns once when host.json does not parse", () => {
    const { targets, warnings } = load("{ not json");

    expect(targets.map((t) => t.url)).toEqual(["http://127.0.0.1:7410/health"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/host\.json/);
  });

  it("leaves the defaults when a new target has no URL", () => {
    const { targets, warnings } = load(JSON.stringify({ health: { targets: [{ name: "relay" }] } }));

    expect(targets.map((t) => t.name)).toEqual(["factory"]);
    expect(warnings).toHaveLength(1);
  });

  it("reads the factory state dir from XDG_STATE_HOME", () => {
    const targets = loadTargets({ env: { XDG_STATE_HOME: "/state" }, home, readFile: () => "{}", warn: () => {} });

    expect(targets[0]?.pidStateDir).toBe("/state/titan-factory");
  });
});
