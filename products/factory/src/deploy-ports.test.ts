import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UNAVAILABLE } from "./deploy-watch-window.js";
import { deployPnpmEnv, runCommand, systemDeployPorts } from "./deploy-ports.js";

const INSTALL = ["install", "--frozen-lockfile"];
const BUILD = ["--filter", "@titan-design/factory...", "build"];

describe("deployPnpmEnv", () => {
  it("lets pnpm switch to the checkout's pinned version, even over an inherited opt-out", () => {
    const env = deployPnpmEnv({ PATH: "/bin", npm_config_manage_package_manager_versions: "false" }, INSTALL);

    expect(env.npm_config_manage_package_manager_versions).toBe("true");
    expect(env.NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS).toBe("true");
  });

  it("purges a foreign modules layout without a prompt that would exit before installing", () => {
    const env = deployPnpmEnv({ PATH: "/bin" }, INSTALL);

    expect(env.CI).toBe("true");
  });

  it("keeps the setup env's other pins and allowlist for the install", () => {
    const env = deployPnpmEnv({ PATH: "/bin", SECRET_TOKEN: "x" }, INSTALL);

    expect(env.npm_config_ignore_scripts).toBe("true");
    expect(env.PATH).toBe("/bin");
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  it("lets the build run scripts, since pinned pnpm 9 leaves node_modules/.bin off PATH under ignore-scripts", () => {
    const env = deployPnpmEnv({ PATH: "/bin", SECRET_TOKEN: "x" }, BUILD);

    expect(env.npm_config_ignore_scripts).toBe("false");
    expect(env.NPM_CONFIG_IGNORE_SCRIPTS).toBe("false");
    expect(env.npm_config_manage_package_manager_versions).toBe("true");
    expect(env.SECRET_TOKEN).toBeUndefined();
  });
});

describe("runCommand", () => {
  const node = (script: string, timeout = 10_000) => runCommand(process.execPath, ["-e", script], process.cwd(), timeout, { PATH: process.env.PATH });

  it("keeps stdout and the exit code when a command fails with nothing on stderr", async () => {
    const result = await node("console.log('tsup: command not found'); process.exit(3)");

    expect(result).toEqual({ code: 3, stdout: "tsup: command not found\n", stderr: "" });
  });

  it("says a command was killed at its timeout", async () => {
    const result = await node("setTimeout(() => {}, 10_000)", 200);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("killed by SIGTERM after the 0.2 s timeout");
  });

  it("exits 127 for a missing binary", async () => {
    const result = await runCommand("no-such-binary-tp-1715", [], process.cwd(), 1_000, { PATH: "/nonexistent" });

    expect(result.code).toBe(127);
  });
});

describe("systemDeployPorts liveness", () => {
  it("a deploy never reads pid 0 as a live holder", () => {
    const ports = systemDeployPorts(tmpdir());

    expect(ports.isAlive(0)).toBe(false);
  });

  it("a negative or non-finite pid is not alive", () => {
    const ports = systemDeployPorts(tmpdir());

    expect([-1, Number.NaN, Number.POSITIVE_INFINITY].map((pid) => ports.isAlive(pid))).toEqual([false, false, false]);
  });

  it("this process is alive", () => {
    const ports = systemDeployPorts(tmpdir());

    expect(ports.isAlive(process.pid)).toBe(true);
  });
});

describe("systemDeployPorts healthWithin (A17: a rate-limited probe never rolls back)", () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  async function serving(status: number, headers: Record<string, string> = {}): Promise<number> {
    server = createServer((_, res) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  it.each([
    [403, {}],
    [403, { "x-ratelimit-remaining": "0" }],
    [422, {}],
    [429, { "retry-after": "30" }],
    [429, {}],
  ])("reads a %i answer as unavailable", async (status, headers) => {
    const port = await serving(status, headers);

    expect(await systemDeployPorts(tmpdir()).healthWithin(port, 2_000)).toBe(UNAVAILABLE);
  });

  it.each([500, 502, 503])("reads a %i answer as no answer, which still counts as an error", async (status) => {
    const port = await serving(status);

    expect(await systemDeployPorts(tmpdir()).healthWithin(port, 2_000)).toBeNull();
  });

  it("reads a 200 answer as the health body", async () => {
    const port = await serving(200);

    expect(await systemDeployPorts(tmpdir()).healthWithin(port, 2_000)).toEqual({ ok: true });
  });
});
