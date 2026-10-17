import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCES_MODES, resolveSources, sourcesReader } from "./mode.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function configDir(): { env: NodeJS.ProcessEnv; write: (text: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), "factory-sources-"));
  dirs.push(dir);
  mkdirSync(join(dir, "titan-factory"));
  return { env: { XDG_CONFIG_HOME: dir }, write: (text) => writeFileSync(join(dir, "titan-factory", "config.json"), text) };
}

const intervals = { pollingIntervalMs: 45_000, backstopIntervalMs: 420_000 };

describe("resolveSources", () => {
  it("names both modes", () => {
    expect(SOURCES_MODES).toEqual(["webhook", "polling"]);
  });

  it.each([
    ["polling", "off", { configured: "polling", effective: "polling", reason: "configured", intervalMs: 45_000 }],
    ["polling", undefined, { configured: "polling", effective: "polling", reason: "configured", intervalMs: 45_000 }],
    ["webhook", "on", { configured: "webhook", effective: "webhook", reason: "configured", intervalMs: 420_000 }],
    ["webhook", "off", { configured: "webhook", effective: "polling", reason: "kill-switch", intervalMs: 45_000 }],
  ] as const)("sources %s with ingress %s resolves as the plan's table says", (sources, ingress, expected) => {
    expect(resolveSources({ github: { sources, ingress, ...intervals } })).toEqual(expected);
  });

  it("refuses sources polling with ingress on", () => {
    expect(() => resolveSources({ github: { sources: "polling", ingress: "on", ...intervals } })).toThrow(/ingress on needs sources webhook/);
  });

  it("resolves no github block as polling at the default 60 s interval", () => {
    expect(resolveSources({})).toEqual({ configured: "polling", effective: "polling", reason: "configured", intervalMs: 60_000 });
  });
});

describe("sourcesReader", () => {
  it("applies an edit on the next read with no restart", () => {
    const { env, write } = configDir();
    write(JSON.stringify({ github: { sources: "webhook", ingress: "on" } }));
    const read = sourcesReader(env);

    write(JSON.stringify({ github: { sources: "webhook", ingress: "off" } }));

    expect(read()).toEqual({ configured: "webhook", effective: "polling", reason: "kill-switch", intervalMs: 60_000 });
  });

  it("keeps the last good value and reports configError once a file turns invalid after start, logging each distinct error once", () => {
    const { env, write } = configDir();
    write(JSON.stringify({ github: { sources: "webhook", ingress: "on" } }));
    const warn = vi.fn();
    const read = sourcesReader(env, { log: { warn } });

    write('{ "github": { "sources": "webh');
    const first = read();
    const second = read();
    write(JSON.stringify({ github: { sources: "polling", ingress: "on" } }));
    const refused = read();

    expect(first).toMatchObject({ configured: "webhook", effective: "webhook", reason: "configured", intervalMs: 300_000, configError: expect.stringMatching(/invalid config/) });
    expect(second).toEqual(first);
    expect(refused).toMatchObject({ effective: "webhook", configError: expect.stringMatching(/github\.ingress/) });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("clears configError once the file is valid again", () => {
    const { env, write } = configDir();
    write(JSON.stringify({ github: { sources: "webhook", ingress: "on" } }));
    const read = sourcesReader(env);
    write("{");
    read();

    write(JSON.stringify({ github: { sources: "polling" } }));

    expect(read()).toEqual({ configured: "polling", effective: "polling", reason: "configured", intervalMs: 60_000 });
  });

  it("throws at construction when the file is invalid, so serve refuses to start", () => {
    const { env, write } = configDir();
    write(JSON.stringify({ github: { sources: "polling", ingress: "on" } }));

    expect(() => sourcesReader(env)).toThrow(/invalid config .*github\.ingress/);
  });
});
