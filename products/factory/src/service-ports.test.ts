import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findOnPath,
  parseCgroupUnit,
  parseCmdline,
  parseSsListeners,
  parseStatStartTime,
  runCommand,
  SERVICE_CHECK_HEALTH_TIMEOUT_MS,
  systemPortOwner,
  systemServicePorts,
} from "./service-ports.js";

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

describe("systemServicePorts health", () => {
  const servers: Server[] = [];
  afterEach(() => {
    servers.splice(0).forEach((server) => {
      server.closeAllConnections();
      server.close();
    });
  });

  /** A /health server that answers after `delayMs`, or never when delayMs is undefined. */
  async function healthServer(delayMs: number | undefined): Promise<number> {
    const server = createServer((_req, res) => {
      if (delayMs === undefined) return;
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })), delayMs);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no tcp address");
    return address.port;
  }

  it("accepts a /health answer that takes 1.5 s, as a loaded serve does", async () => {
    const port = await healthServer(1500);

    expect(await systemServicePorts().health(port)).toEqual({ ok: true });
  });

  it("gives up on a /health that never answers within the bounded timeout", async () => {
    const port = await healthServer(undefined);
    const started = Date.now();

    expect(await systemServicePorts().health(port)).toBeNull();
    expect(Date.now() - started).toBeLessThan(SERVICE_CHECK_HEALTH_TIMEOUT_MS + 2_000);
  }, 15_000);
});

describe("port owner readers", () => {
  it("reads the holder's pid from ss, and an absent pid for another user's socket", () => {
    const ss = [
      'LISTEN 0      511        127.0.0.1:7410       0.0.0.0:*    users:(("MainThread",pid=3571910,fd=27))',
      "LISTEN 0      511        127.0.0.1:7410       0.0.0.0:*",
      "",
    ].join("\n");

    expect(parseSsListeners(ss)).toEqual([{ pid: 3571910 }, {}]);
    expect(parseSsListeners("")).toEqual([]);
  });

  it("reads argv from the NUL-separated cmdline, not the MainThread comm", () => {
    const argv = ["/usr/bin/node", "/srv/deploy/titan-platform/products/factory/dist/bin.js", "serve", "--port", "7410"];

    expect(parseCmdline(`${argv.join("\0")}\0`)).toEqual(argv);
    expect(parseCmdline("")).toEqual([]);
  });

  it("names the innermost service in a cgroup v2 path, and none for a session scope", () => {
    expect(parseCgroupUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/titan-factory.service\n")).toBe("titan-factory.service");
    expect(parseCgroupUnit("0::/user.slice/user-1000.slice/session-3.scope\n")).toBeUndefined();
  });

  it("reads start time from field 22 of stat, even when comm holds spaces and parentheses", () => {
    const rest = Array.from({ length: 50 }, (_, index) => String(index + 3)).join(" ");

    expect(parseStatStartTime(`3571910 (Main) Thread) ${rest}`)).toBe("22");
  });

  it("is set on the system ports for Linux and macOS alike", () => {
    expect(systemServicePorts().portOwner).toBeDefined();
    expect(systemPortOwner("darwin").listeners).toBeTypeOf("function");
  });

  it("reads this process's own argv and start time through /proc on Linux", async () => {
    if (process.platform !== "linux") return;

    const info = await systemPortOwner("linux").processInfo(process.pid);

    expect(info?.argv.length).toBeGreaterThan(0);
    expect(info?.startedAt).toMatch(/^\d+$/);
  });
});
