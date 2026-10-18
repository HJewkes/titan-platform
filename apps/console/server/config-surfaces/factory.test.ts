import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import { parseTerms, scanText } from "@titan-design/egress-scan";
import { resolveConfig } from "../config.js";
import { startConsoleDaemon } from "../daemon.js";
import { closedPort, send } from "../test-support.js";
import type { ConfigRow, ConfigSurfaces } from "./catalog.js";
import { CONSOLE_ENV_FILE, consoleEnvSurfaces, factorySurfaces } from "./factory.js";

const PUSH_URL = "https://push.example.test/topic-d1g3st-5ecret";
const UNDECLARED_VALUE = "undeclared-factory-value-4b7e";
const NESTED_VALUE = "nested-review-value-c38a";
const DEPLOY_REMOTE = "https://someone:remote-pass-0a9f@git.example.test/repo.git";
const ENV_VALUE = "undeclared-env-value-77d1";
/** Built at runtime so no token-shaped literal is committed. */
const GITHUB_TOKEN = `ghp_${"A".repeat(36)}`;

const FACTORY = {
  dbPath: "/srv/factory/factory.sqlite3",
  digest: { timezone: "UTC", slots: [7, 19], push: { url: PUSH_URL, tokenFile: "/srv/factory/push.token" } },
  service: { labelPrefix: "test.example.", deployRemote: DEPLOY_REMOTE },
  relayToken: UNDECLARED_VALUE,
  shepherd: {
    hubSeat: "seat-k",
    spawnGate: { load5: 48, buildLoad5: 40 },
    review: { profile: "reviewer-a", maxConcurrent: 24, roles: { g10: "reviewer-b" }, note: NESTED_VALUE },
    gateReset: { twoMergeRelease: "shadow" },
    visualDelivery: { mode: "shadow", push: { url: PUSH_URL } },
    repos: { "org-a/repo-1": { advisory: true, extra: { token: GITHUB_TOKEN } } },
  },
};

const SECRETS = [PUSH_URL, UNDECLARED_VALUE, NESTED_VALUE, DEPLOY_REMOTE, ENV_VALUE, GITHUB_TOKEN];

let root: string;
let factoryFile: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "factory-surfaces-"));
  factoryFile = path.join(root, "titan-factory", "config.json");
  await mkdir(path.dirname(factoryFile), { recursive: true });
  await writeFile(factoryFile, JSON.stringify(FACTORY, null, 2));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const row = (surfaces: ConfigSurfaces, field: string): ConfigRow | undefined => surfaces.rows.find((entry) => entry.field === field);
const shownFields = (surfaces: ConfigSurfaces): string[] => surfaces.rows.filter((entry) => !entry.hidden).map((entry) => entry.field);

/**
 * Every leak the payload could hold: a private term per secret, plus the scanner's own credential and
 * path shapes. The fixture root is masked first, since a temp dir may itself sit under a home dir.
 */
function leaks(payload: string): string[] {
  return scanText(payload.replaceAll(root, "/srv/fixture"), { terms: parseTerms(SECRETS.join("\n")) }).map((finding) => `${finding.location} ${finding.rule}`);
}

describe("config.surfaces over the daemon's RPC", () => {
  let handle: DaemonHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function surfacesPayload(): Promise<string> {
    const closed = String(await closedPort());
    const env = {
      TITAN_CONSOLE_STATE: path.join(root, "state"),
      TITAN_CONSOLE_PORT: "0",
      TITAN_CONSOLE_ACTIVE_WORK_PORT: closed,
      TITAN_CONSOLE_AGENT_CHAT_PORT: closed,
      TITAN_CONSOLE_FACTORY_PORT: closed,
      TITAN_CONSOLE_FACTORY_CONFIG: factoryFile,
      TITAN_CONSOLE_CLAUDE_DIRS: path.join(root, "claude-a"),
      TITAN_CONSOLE_RELAY_SECRET: ENV_VALUE,
      AGENT_CHAT_HOME: path.join(root, "agent-chat"),
    };
    handle = await startConsoleDaemon({ config: resolveConfig(env, root), logger: silentLogger });
    const host = `127.0.0.1:${handle.port}`;
    const reply = await send("127.0.0.1", handle.port, "POST", "/rpc/config.surfaces", { host, "content-type": "application/json", "x-titan-client": "test" }, "{}");
    expect(reply.status).toBe(200);
    return reply.body;
  }

  it("carries no push URL, undeclared value or token anywhere in the response", async () => {
    const payload = await surfacesPayload();

    expect(leaks(payload)).toEqual([]);
    for (const secret of SECRETS) expect(payload).not.toContain(secret);
  });

  it("lists the push block and the undeclared keys as hidden rows", async () => {
    const body: unknown = JSON.parse(await surfacesPayload());

    const hidden = ["digest.push", "relayToken", "service.deployRemote", "shepherd.review.note", "shepherd.visualDelivery.push"].map((field) =>
      expect.objectContaining({ surface: "factory-config", field, hidden: true }),
    );
    const shownGate = expect.objectContaining({ surface: "factory-config", field: "shepherd.spawnGate.load5", hidden: false, value: 48 });
    const hiddenEnv = expect.objectContaining({ surface: "console-env", field: "TITAN_CONSOLE_RELAY_SECRET", hidden: true });
    expect(body).toMatchObject({ ok: true, data: { rows: expect.arrayContaining([...hidden, shownGate, hiddenEnv]) } });
  });
});

describe("factorySurfaces", () => {
  it("shows the allowlisted knobs with their lines", async () => {
    const surfaces = await factorySurfaces(factoryFile)();

    expect(shownFields(surfaces)).toEqual([
      "dbPath", "digest.timezone", "digest.slots", "service.labelPrefix", "shepherd.hubSeat", "shepherd.spawnGate.load5", "shepherd.spawnGate.buildLoad5",
      "shepherd.review.profile", "shepherd.review.maxConcurrent", "shepherd.review.roles.g10", "shepherd.gateReset.twoMergeRelease",
      "shepherd.visualDelivery.mode", "shepherd.repos.org-a/repo-1.advisory",
    ]);
    expect(row(surfaces, "shepherd.review.maxConcurrent")).toMatchObject({ value: 24, line: 27 });
    expect(surfaces.files).toEqual([expect.objectContaining({ surface: "factory-config", inventory: 19, group: "factory", file: factoryFile })]);
  });

  it("hides a map that lands under an allowed pattern rather than showing what it holds", async () => {
    const surfaces = await factorySurfaces(factoryFile)();

    expect(row(surfaces, "shepherd.repos.org-a/repo-1.extra")).toMatchObject({ hidden: true });
    expect(JSON.stringify(surfaces)).not.toContain(GITHUB_TOKEN);
  });

  it("answers a gap when the factory has no config on this host", async () => {
    const surfaces = await factorySurfaces(path.join(root, "absent.json"))();

    expect(surfaces).toEqual({ files: [], rows: [], gaps: [`${path.join(root, "absent.json")}: missing`] });
  });
});

describe("consoleEnvSurfaces", () => {
  it("shows every declared variable, set or not, and hides an undeclared one", async () => {
    const surfaces = await consoleEnvSurfaces({ TITAN_CONSOLE_PORT: "7501", TITAN_CONSOLE_RELAY_SECRET: ENV_VALUE }, "2026-10-18T00:00:00.000Z")();

    expect(row(surfaces, "TITAN_CONSOLE_PORT")).toMatchObject({ hidden: false, value: "7501", file: CONSOLE_ENV_FILE, line: 0 });
    expect(row(surfaces, "TITAN_CONSOLE_OWNER_WRITES")).toMatchObject({ hidden: false, value: null, comment: "unset; the default applies" });
    expect(row(surfaces, "TITAN_CONSOLE_RELAY_SECRET")).toEqual({ surface: "console-env", file: CONSOLE_ENV_FILE, field: "TITAN_CONSOLE_RELAY_SECRET", line: 0, hidden: true, decisions: [] });
    expect(row(surfaces, "TITAN_CONSOLE_CODEWATCH_URL")).toBeUndefined();
    expect(surfaces.files).toEqual([expect.objectContaining({ surface: "console-env", inventory: 22, group: "console" })]);
  });
});
