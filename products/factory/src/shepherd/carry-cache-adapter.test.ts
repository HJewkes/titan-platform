import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindCarryStateDir, hostCarryPorts, systemGit } from "./carry-cache-adapter.js";
import { carryCacheDir, localMergeTree } from "./tree-carry.js";

const REPO = "acme/widgets";

let root: string;
let bare: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carry-cache-adapter-"));
  bare = join(root, "cache.git");
  gitIn(root)("init", "--bare", "--quiet", bare);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A synthetic origin with one commit on main, readable by sha. */
function seededOrigin(): { origin: string; head: string } {
  const origin = join(root, "origin");
  seedRepo(origin, {});
  gitIn(origin)("config", "uploadpack.allowAnySHA1InWant", "true");
  const [head = ""] = withHistory(origin, [{ files: { "a.txt": "a0\n" }, message: "edit a.txt" }]);
  return { origin, head };
}

/** A loopback git remote that asks every request for a username and password. */
async function authWall(): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => response.writeHead(401, { "WWW-Authenticate": 'Basic realm="synthetic"' }).end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the auth wall has no port");
  return { url: `http://127.0.0.1:${address.port}/acme/widgets.git`, server };
}

const mergeTreeOf = (origin: string, headSha: string): Promise<string> => localMergeTree({ repo: REPO, baseRef: "main", headSha }, { ports: hostCarryPorts, remote: () => origin });

describe("systemGit", { timeout: 30_000 }, () => {
  it("systemGit never prompts and reads only gh as a credential helper", async () => {
    const { url, server } = await authWall();
    // The trailing reset keeps the test from running gh; the command-scope helpers below are the ones systemGit sets.
    const asked = await systemGit(bare, ["-c", "credential.helper=", "ls-remote", url]).finally(() => server.close());
    const helpers = await systemGit(bare, ["config", "--show-scope", "--get-all", "credential.helper"]);

    expect(asked.code).toBe(128);
    expect(asked.stderr).toMatch(/terminal prompts disabled/);
    const commandScope = helpers.stdout.split("\n").filter((line) => line.startsWith("command\t"));
    expect(commandScope).toEqual(["command\t", "command\t!gh auth git-credential"]);
    expect(helpers.stdout.trimEnd().split("\n").at(-1)).toBe("command\t!gh auth git-credential");
  });

  it("systemGit answers a failing command with its exit code instead of rejecting", async () => {
    const missingRef = await systemGit(bare, ["rev-parse", "--verify", "--quiet", "refs/heads/absent"]);
    const missingDir = await systemGit(join(root, "absent.git"), ["rev-parse", "HEAD"]);

    expect(missingRef.code).toBe(1);
    expect(missingDir.code).toBe(128);
    expect(missingDir.stderr).not.toBe("");
  });
});

describe("hostCarryPorts", { timeout: 30_000 }, () => {
  it("hostCarryPorts reads the bound state dir at call time, not when the ports are built", async () => {
    const { origin, head } = seededOrigin();
    const ports = hostCarryPorts;
    const stateDir = join(root, "bound");
    vi.stubEnv("TITAN_FACTORY_DB", join(root, "db", "factory.db"));

    const unbind = bindCarryStateDir(stateDir);
    try {
      expect(ports.stateDir()).toBe(stateDir);
      expect(await mergeTreeOf(origin, head)).toBe("clean");
    } finally {
      unbind();
    }

    expect(existsSync(join(carryCacheDir(stateDir, REPO), "HEAD"))).toBe(true);
    expect(existsSync(join(root, "db", "git-cache"))).toBe(false);
    expect(ports.stateDir()).toBe(join(root, "db"));
  });

  it("an unbound hostCarryPorts falls back to the configured database's directory", async () => {
    const { origin, head } = seededOrigin();
    const dbDir = join(root, "db");
    vi.stubEnv("TITAN_FACTORY_DB", join(dbDir, "factory.db"));

    expect(hostCarryPorts.stateDir()).toBe(dbDir);
    expect(await mergeTreeOf(origin, head)).toBe("clean");
    expect(existsSync(join(carryCacheDir(dbDir, REPO), "HEAD"))).toBe(true);
  });
});
