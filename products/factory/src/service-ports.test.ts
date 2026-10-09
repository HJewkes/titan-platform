import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findOnPath, runCommand, systemServicePorts } from "./service-ports.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** Two PATH directories: `first` holds a non-executable gh and a directory named claude, `second` holds a real gh and a symlink to it. */
function pathDirs(): { first: string; second: string; pathVar: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-which-"));
  dirs.push(root);
  const [first, second] = [join(root, "first"), join(root, "second")];
  mkdirSync(join(first, "claude"), { recursive: true });
  mkdirSync(join(second, "cellar"), { recursive: true });
  writeFileSync(join(first, "gh"), "not executable");
  writeFileSync(join(second, "cellar", "gh"), "#!/bin/sh\n");
  chmodSync(join(second, "cellar", "gh"), 0o755);
  symlinkSync(join(second, "cellar", "gh"), join(second, "gh"));
  return { first, second, pathVar: `relative/bin::${first}:${second}` };
}

describe("findOnPath", () => {
  it("returns the first executable file, as the symlink PATH names and not its target", () => {
    const { second, pathVar } = pathDirs();

    expect(findOnPath("gh", pathVar)).toBe(join(second, "gh"));
  });

  it("skips a relative PATH entry, even one that holds the binary", () => {
    const { second } = pathDirs();

    expect(findOnPath("gh", relative(process.cwd(), second))).toBeUndefined();
  });

  it("finds nothing for a directory, a missing name or an unset PATH", () => {
    const { pathVar } = pathDirs();

    expect(findOnPath("claude", pathVar)).toBeUndefined();
    expect(findOnPath("agent-chat", pathVar)).toBeUndefined();
    expect(findOnPath("gh", undefined)).toBeUndefined();
  });
});

describe("runCommand", () => {
  it("resolves with the output of a command that exits 0", async () => {
    expect(await runCommand(process.execPath, ["-e", "process.stdout.write('loaded')"])).toEqual({ code: 0, stdout: "loaded", stderr: "" });
  });

  it("resolves with the exit code and stderr of a command that fails, instead of rejecting", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stderr.write('Bootstrap failed'); process.exit(5)"]);

    expect(result).toEqual({ code: 5, stdout: "", stderr: "Bootstrap failed" });
  });

  it("resolves undefined when the binary is not on PATH", async () => {
    expect(await runCommand("tp-574-no-such-binary", ["mcp", "add"])).toBeUndefined();
  });
});

describe("systemServicePorts label prefix", () => {
  function configHome(config: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "factory-ports-cfg-"));
    dirs.push(root);
    mkdirSync(join(root, "titan-factory"));
    writeFileSync(join(root, "titan-factory", "config.json"), JSON.stringify(config));
    return root;
  }

  it("carries service.labelPrefix from the config in the env", () => {
    vi.stubEnv("XDG_CONFIG_HOME", configHome({ service: { labelPrefix: "dev.ex." } }));

    const ports = systemServicePorts();

    expect(ports.labelPrefix).toBe("dev.ex.");
    expect(ports.configError).toBeUndefined();
  });

  it("leaves labelPrefix unset when the config names none", () => {
    vi.stubEnv("XDG_CONFIG_HOME", configHome({}));

    expect(systemServicePorts().labelPrefix).toBeUndefined();
  });

  it("carries the load error instead of a prefix when the config is malformed", () => {
    vi.stubEnv("XDG_CONFIG_HOME", configHome({ service: { labelPrefix: "dev.ex." }, digest: { queuesdir: "/srv/queues" } }));

    const ports = systemServicePorts();

    expect(ports.labelPrefix).toBeUndefined();
    expect(ports.configError).toMatch(/^invalid config .*config\.json: digest/);
  });

});
