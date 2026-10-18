import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { invokeCommand } from "@titan-design/registry";
import type { ConsoleContext } from "../owner-guard.js";
import { CONFIG_REPORT, CONFIG_REPORT_SCHEMA, MAX_REPORTING_HOSTS, hostReportsCommands, type HostView } from "./host-reports.js";

const REMOTE_BEARER: RequestAuth = { credential: "bearer", issuedAt: null, peerLocal: false };
const RECEIVED = new Date("2026-03-02T12:00:00.000Z");

let root: string;
let reportsDir: string;
let now: Date;

function http(auth: RequestAuth | null): ConsoleContext {
  return { warnings: [], format: "json", surface: "http", auth, ownerWrites: true };
}

const CONFIG_ROW = {
  kind: "agent-chat-config",
  inventory: 7,
  file: "~/.agent-chat/config.json",
  present: true,
  secret: false,
  mode: "0644",
  bytes: 120,
  mtime: "2026-03-01T09:00:00.000Z",
  sha256: "a".repeat(64),
};

const TOKEN_ROW = { kind: "agent-chat-ui-token", inventory: 13, file: "~/.agent-chat/ui.token", present: true, secret: true, mode: "0600", mtime: "2026-02-01T09:00:00.000Z" };

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: CONFIG_REPORT_SCHEMA,
    host: "laptop-a",
    platform: "darwin",
    reportedAt: "2026-03-02T11:59:00.000Z",
    surfaces: [CONFIG_ROW, TOKEN_ROW],
    ...overrides,
  };
}

const commands = () => hostReportsCommands({ dir: reportsDir, now: () => now });

async function deposit(body: unknown, auth: RequestAuth | null = REMOTE_BEARER) {
  return (await invokeCommand(commands()[CONFIG_REPORT], body, http(auth))).envelope;
}

async function hosts(): Promise<HostView[]> {
  const read = commands()["config.hosts"];
  const { envelope } = await invokeCommand(read, {}, http(null));
  if (!envelope.ok) throw new Error(envelope.error);
  return read.result.parse(envelope.data).hosts;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "host-reports-"));
  reportsDir = path.join(root, "state", "config", "host-reports");
  now = RECEIVED;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("config.report", () => {
  it("takes a report over a remote bearer and shows it, without touching the files it names", async () => {
    const home = path.join(root, "home");
    const named = path.join(home, "config.json");
    await mkdir(home);
    await writeFile(named, '{"worktreeBudget":12}\n');

    const reply = await deposit(report({ surfaces: [{ ...CONFIG_ROW, file: named }] }));

    expect(reply).toMatchObject({ ok: true, data: { host: "laptop-a", receivedAt: RECEIVED.toISOString() } });
    const [shown] = await hosts();
    expect(shown).toMatchObject({ host: "laptop-a", status: "reported", platform: "darwin" });
    expect(shown?.surfaces.map((surface) => surface.file)).toEqual([named]);
    expect(await readdir(home)).toEqual(["config.json"]);
    expect(await readFile(named, "utf8")).toBe('{"worktreeBudget":12}\n');
    expect(await readdir(reportsDir)).toEqual(["laptop-a.json"]);
    expect((await stat(path.join(reportsDir, "laptop-a.json"))).mode & 0o777).toBe(0o600);
  });

  it("refuses a report carrying a revision and stores nothing", async () => {
    const reply = await deposit(report({ revision: { path: "worktreeBudget", value: 64 } }));

    expect(reply.ok).toBe(false);
    expect(reply.ok ? "" : reply.error).toMatch(/revision/);
    expect(await hosts()).toEqual([]);
  });

  it("refuses a revision tucked inside a surface row", async () => {
    const reply = await deposit(report({ surfaces: [{ ...CONFIG_ROW, revision: 3 }] }));

    expect(reply.ok).toBe(false);
  });

  it("shows a host whose report is 25 hours and a minute old as not reported, with no surfaces", async () => {
    await deposit(report());
    now = new Date(RECEIVED.getTime() + (25 * 60 + 1) * 60 * 1000);

    const [shown] = await hosts();

    expect(shown).toMatchObject({ host: "laptop-a", status: "not reported", surfaces: [] });
  });

  it("dates a report from its own stamp when that is older than its arrival", async () => {
    await deposit(report({ reportedAt: "2026-02-28T12:00:00.000Z" }));

    expect((await hosts())[0]?.status).toBe("not reported");
  });

  it.each([
    ["loopback, with no credential", null],
    ["an owner session cookie", { credential: "session", issuedAt: 1_000, peerLocal: false }],
    ["a bearer from this machine", { credential: "bearer", issuedAt: null, peerLocal: true }],
  ] as const)("refuses %s", async (_name, auth) => {
    const reply = await deposit(report(), auth);

    expect(reply).toMatchObject({ ok: false });
    expect(await hosts()).toEqual([]);
  });

  it("refuses a size or digest on a secret surface", async () => {
    expect((await deposit(report({ surfaces: [{ ...TOKEN_ROW, sha256: "b".repeat(64) }] }))).ok).toBe(false);
  });

  it("refuses a host name that could leave the report directory", async () => {
    expect((await deposit(report({ host: "../owner-actions" }))).ok).toBe(false);
  });

  it("replaces a host's report and refuses a host past the cap", async () => {
    for (let index = 0; index < MAX_REPORTING_HOSTS; index += 1) await deposit(report({ host: `host-${index}` }));

    const repeat = await deposit(report({ host: "host-0", platform: "linux" }));
    const extra = await deposit(report({ host: "one-too-many" }));

    expect(repeat.ok).toBe(true);
    expect(extra).toMatchObject({ ok: false, error: `the console already holds reports from ${MAX_REPORTING_HOSTS} hosts` });
    expect(JSON.parse(await readFile(path.join(reportsDir, "host-0.json"), "utf8"))).toMatchObject({ report: { platform: "linux" } });
  });
});

describe("config.hosts", () => {
  it("names a stored file that is not a report as a gap", async () => {
    await deposit(report());
    await writeFile(path.join(reportsDir, "broken.json"), "{");

    const { envelope } = await invokeCommand(commands()["config.hosts"], {}, http(null));

    expect(envelope).toMatchObject({ ok: true, data: { gaps: ["broken.json: not a stored config report"] } });
  });
});
