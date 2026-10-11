import { execFile } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import { depositItemId, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { MAX_DEPOSIT_BYTES, readSpool, writeAnswer, writeDeposit } from "@titan-design/owner-queue/spool";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import { INBOX_DEPOSIT, INBOX_DEPOSIT_BODY_LIMIT, MAX_OPEN_DEPOSITS, MAX_OPEN_DEPOSITS_PER_ASKER, fileDeposit } from "./inbox.js";
import { closedPort, send, type Reply } from "./test-support.js";

const ASKER = "pc-test-agent";

function deposit(overrides: Record<string, unknown> = {}): OwnerItemDeposit & Record<string, unknown> {
  return {
    depositId: "ask-1",
    asker: ASKER,
    kind: "decide",
    door: "two-way",
    summary: "Ship the widget behind a flag?",
    context: "The flag defaults off.",
    options: [
      { id: "yes", label: "Ship it" },
      { id: "no", label: "Hold" },
    ],
    recommended: { optionId: "yes", by: ASKER, rationale: "Off by default" },
    ...overrides,
  };
}

let dir: string;
let config: ConsoleConfig;
let handle: DaemonHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-"));
  config = {
    port: 0,
    stateDir: path.join(dir, "state"),
    activeWorkPort: await closedPort(),
    agentChatPort: await closedPort(),
    agentChatTokenPath: path.join(dir, "ui.token"),
    agentChatEventsDbPath: path.join(dir, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(dir, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: null,
    lanTokenPath: path.join(dir, "state", "lan.token"),
    ownerWrites: false,
    inboxDir: path.join(dir, "state", "inbox", "deposits"),
    roundsDir: path.join(dir, "state", "rounds"),
  };
  handle = await startConsoleDaemon({ config, logger: silentLogger });
  config = { ...config, port: handle.port };
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string> = { "x-titan-client": "test" }): Promise<Reply> => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return send("127.0.0.1", config.port, "POST", `/rpc/${INBOX_DEPOSIT}`, { host: `127.0.0.1:${config.port}`, "content-type": "application/json", ...headers }, raw);
};

/** JSON with every non-ASCII code unit written as `\uXXXX`, the way Python's json.dumps writes it. */
const asciiEscaped = (value: unknown): string =>
  JSON.stringify(value).replace(/[\u0080-￿]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);

const bodyOf = (reply: Reply): { ok: boolean; data?: { id: string; created: boolean }; error?: string } => JSON.parse(reply.body);

/** Writes a chunked body with no Content-Length, chunk by chunk, and stops as soon as the console answers. */
function streamOversizeDeposit(): Promise<{ status: number; sent: number; total: number }> {
  const chunk = Buffer.alloc(16 * 1024, 0x20);
  const total = 64 * 1024 * 1024;
  const headers = { host: `127.0.0.1:${config.port}`, "content-type": "application/json", "x-titan-client": "test", "transfer-encoding": "chunked" };
  return new Promise((resolve, reject) => {
    let sent = 0;
    let answered = false;
    const req = request({ host: "127.0.0.1", port: config.port, path: `/rpc/${INBOX_DEPOSIT}`, method: "POST", headers }, (res) => {
      answered = true;
      res.resume();
      res.on("end", () => {
        req.destroy();
        resolve({ status: res.statusCode ?? 0, sent, total });
      });
    });
    req.on("error", (error) => {
      if (!answered) reject(error);
    });
    const pump = (): void => {
      while (!answered && sent < total) {
        sent += chunk.length;
        if (!req.write(chunk)) return void req.once("drain", pump);
      }
      if (!answered) req.end();
    };
    pump();
  });
}

async function spoolFiles(): Promise<string[]> {
  return (await readdir(config.inboxDir).catch(() => [])).filter((name) => !name.startsWith("."));
}

/** Every file under the temp root, relative to it, so a test can prove nothing landed outside the spool. */
async function allFiles(): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

describe("inbox.deposit on loopback", () => {
  it("files a deposit as one 0600 file in a 0700 spool and answers with its item id", async () => {
    const reply = await post(deposit());

    expect(reply.status).toBe(200);
    expect(bodyOf(reply).data).toEqual({ id: depositItemId(ASKER, "ask-1"), created: true });
    const files = await spoolFiles();
    expect(files).toHaveLength(1);
    expect((await stat(path.join(config.inboxDir, files[0]!))).mode & 0o777).toBe(0o600);
    expect((await stat(config.inboxDir)).mode & 0o777).toBe(0o700);
  });

  it("answers a repeat depositId with the existing item id and keeps the first body", async () => {
    await post(deposit());

    const repeat = await post(deposit({ summary: "A different summary" }));

    expect(repeat.status).toBe(200);
    expect(bodyOf(repeat).data).toEqual({ id: depositItemId(ASKER, "ask-1"), created: false });
    const { items } = await readSpool(config.inboxDir);
    expect(items.map((item) => item.summary)).toEqual(["Ship the widget behind a flag?"]);
  });

  it.each([
    ["id", { id: "deposit:forged" }],
    ["status", { status: "answered" }],
    ["answer", { answer: { optionId: "yes", by: { class: "owner", id: "owner", channel: "console" }, at: "2026-01-01T00:00:00Z" } }],
    ["route", { route: { target: "owner", reason: "forged", shadow: false } }],
    ["authority", { authority: { table: "t", ruleId: "r", resolvers: ["owner"] } }],
    ["lint", { lint: [] }],
    ["sources", { sources: [{ system: "agent-chat", ref: "x" }] }],
    ["recommended.hidden", { recommended: { optionId: "yes", by: ASKER, hidden: true } }],
  ])("refuses a body carrying the system field %s with 400 and files nothing", async (_field, overrides) => {
    const reply = await post(deposit(overrides));

    expect(reply.status).toBe(400);
    expect(bodyOf(reply).ok).toBe(false);
    expect(await spoolFiles()).toEqual([]);
  });

  it(`answers 413 to a Content-Length over ${INBOX_DEPOSIT_BODY_LIMIT} bytes`, async () => {
    const reply = await post(deposit({ context: "x".repeat(INBOX_DEPOSIT_BODY_LIMIT) }));

    expect(reply.status).toBe(413);
    expect(await spoolFiles()).toEqual([]);
  });

  it("answers 413 to a chunked body past the cap before the client has sent it all", async () => {
    const { status, sent, total } = await streamOversizeDeposit();

    expect(status).toBe(413);
    expect(sent).toBeLessThan(total);
    expect(await spoolFiles()).toEqual([]);
  });

  it.each([
    ["two-byte U+00E9", "é", 2],
    ["astral U+1F600", "\u{1F600}", 4],
  ])("files a deposit just under 64 KB of %s sent as \\uXXXX escapes", async (_name, char, storedBytes) => {
    // The schema's parse adds a few fields to what is stored, so leave headroom for them.
    const room = MAX_DEPOSIT_BYTES - 1024 - Buffer.byteLength(JSON.stringify(deposit({ context: "" })));
    const full = deposit({ context: char.repeat(Math.floor(room / storedBytes)) });
    const raw = asciiEscaped(full);

    const reply = await post(raw);

    expect(Buffer.byteLength(raw)).toBeGreaterThan(2 * MAX_DEPOSIT_BYTES);
    expect(reply.status).toBe(200);
    const { items } = await readSpool(config.inboxDir);
    expect(items.map((item) => item.context)).toEqual([full.context]);
  });

  it("refuses a deposit over 64 KB with 400 and files nothing", async () => {
    const reply = await post(deposit({ context: "x".repeat(64 * 1024) }));

    expect(reply.status).toBe(400);
    expect(bodyOf(reply).error).toBe("deposit exceeds 65536 bytes");
    expect(await spoolFiles()).toEqual([]);
  });

  it.each(["__proto__", "constructor"])("refuses a body carrying a %s key with 400 and files nothing", async (key) => {
    const raw = JSON.stringify(deposit()).replace(/^\{/, `{"${key}":{"status":"answered"},`);

    const reply = await post(raw);

    expect(reply.status).toBe(400);
    expect(await spoolFiles()).toEqual([]);
  });

  it("refuses a __proto__ key nested in recommended with 400", async () => {
    const raw = JSON.stringify(deposit()).replace('"recommended":{', '"recommended":{"__proto__":{"hidden":true},');

    const reply = await post(raw);

    expect(reply.status).toBe(400);
    expect(await spoolFiles()).toEqual([]);
  });

  it("refuses a lone-surrogate asker with 400, so it cannot take the name of a U+FFFD asker", async () => {
    await post(deposit({ asker: "agent-�" }));

    const reply = await post(deposit({ asker: "agent-\uD800" }));

    expect(reply.status).toBe(400);
    expect(bodyOf(reply).error).toMatch(/well-formed/);
    expect(await spoolFiles()).toHaveLength(1);
  });

  it("files Bob and bob as two deposits, never a created:false for the second", async () => {
    const upper = await post(deposit({ asker: "Bob" }));
    const lower = await post(deposit({ asker: "bob" }));

    expect([bodyOf(upper).data?.created, bodyOf(lower).data?.created]).toEqual([true, true]);
    expect(await spoolFiles()).toHaveLength(2);
  });

  it("refuses an asker too long to name a file with 400 rather than 500", async () => {
    const reply = await post(deposit({ asker: "a".repeat(300) }));

    expect(reply.status).toBe(400);
    expect(await spoolFiles()).toEqual([]);
  });

  it("files a deposit whose asker and depositId carry ../ and NUL inside the spool and nowhere else", async () => {
    const before = await allFiles();

    const reply = await post(deposit({ asker: "../../../escape\u0000", depositId: "../../etc/passwd\u0000.json" }));

    expect(reply.status).toBe(200);
    const files = await spoolFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/\.\.|\/|\0/);
    const added = (await allFiles()).filter((file) => !before.includes(file));
    expect(added).toEqual([path.relative(dir, path.join(config.inboxDir, files[0]!))]);
  });

  it("never writes an answer: no answer file appears and the filed item is open", async () => {
    await post(deposit());

    const { items } = await readSpool(config.inboxDir);

    expect(items.map((item) => [item.status, item.answer])).toEqual([["open", undefined]]);
    expect((await spoolFiles()).filter((name) => name.endsWith(".answer.json"))).toEqual([]);
  });

  it("refuses a POST with neither Origin nor X-Titan-Client, so a web page cannot file", async () => {
    const reply = await post(deposit(), {});

    expect(reply.status).toBe(403);
    expect(await spoolFiles()).toEqual([]);
  });
});

describe("the open-deposit cap", () => {
  async function fillTo(count: number, asker = ASKER): Promise<void> {
    for (let index = 0; index < count; index += 1) await writeDeposit(config.inboxDir, deposit({ asker, depositId: `seed-${index}` }));
  }

  it(`answers 429 to an asker's open deposit number ${MAX_OPEN_DEPOSITS_PER_ASKER + 1}, and still files for another asker`, async () => {
    await fillTo(MAX_OPEN_DEPOSITS_PER_ASKER);

    const over = await post(deposit({ depositId: "one-too-many" }));
    const other = await post(deposit({ asker: "another-agent", depositId: "one-too-many" }));

    expect([over.status, other.status]).toEqual([429, 200]);
    expect(bodyOf(over).error).toBe(`this asker already has ${MAX_OPEN_DEPOSITS_PER_ASKER} open deposits`);
    expect(await spoolFiles()).toHaveLength(MAX_OPEN_DEPOSITS_PER_ASKER + 1);
  });

  it("still answers a repeat depositId at the cap with its existing id", async () => {
    await fillTo(MAX_OPEN_DEPOSITS_PER_ASKER);

    const repeat = await post(deposit({ depositId: "seed-0" }));

    expect(repeat.status).toBe(200);
    expect(bodyOf(repeat).data).toEqual({ id: depositItemId(ASKER, "seed-0"), created: false });
  });

  it("counts only open deposits: an answered one frees a slot", async () => {
    await fillTo(MAX_OPEN_DEPOSITS_PER_ASKER);
    await writeAnswer(config.inboxDir, depositItemId(ASKER, "seed-7"), { optionId: "yes", by: { class: "owner", id: "owner", channel: "console" }, at: "2026-01-01T00:00:00Z" });

    const reply = await post(deposit({ depositId: "after-an-answer" }));

    expect(reply.status).toBe(200);
  });

  it("lets only one of several racing deposits take the last slot", async () => {
    await fillTo(MAX_OPEN_DEPOSITS_PER_ASKER - 1);

    const replies = await Promise.all([0, 1, 2, 3, 4].map((index) => post(deposit({ depositId: `race-${index}` }))));

    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 429, 429, 429, 429]);
  });

  it("does not count another asker whose name shares a prefix", async () => {
    await fillTo(MAX_OPEN_DEPOSITS_PER_ASKER, `${ASKER}-2`);

    const reply = await post(deposit());

    expect(reply.status).toBe(200);
  });

  it(`answers 429 once the spool holds ${MAX_OPEN_DEPOSITS} open deposits, however many askers were invented`, { timeout: 30_000 }, async () => {
    for (let index = 0; index < MAX_OPEN_DEPOSITS; index += 1) {
      await writeDeposit(config.inboxDir, deposit({ asker: `invented-${index}`, depositId: "seed" }));
    }

    const fresh = await post(deposit({ asker: "never-seen-before" }));
    const repeat = await post(deposit({ asker: "invented-0", depositId: "seed" }));

    expect(fresh.status).toBe(429);
    expect(bodyOf(fresh).error).toBe(`the inbox already has ${MAX_OPEN_DEPOSITS} open deposits`);
    expect(bodyOf(repeat).data).toEqual({ id: depositItemId("invented-0", "seed"), created: false });
  });
});

/** Runs the real bin against the test's daemon, the way an agent would. */
function runCli(args: string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  const consoleDir = path.join(import.meta.dirname, "..");
  const env = { ...process.env, TITAN_CONSOLE_PORT: String(config.port), TITAN_CONSOLE_STATE: config.stateDir, TITAN_CONSOLE_HOST: "", TITAN_CONSOLE_LAN_NAMES: "lan-box" };
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ["--import", "tsx", "server/cli.ts", "inbox", "file", ...args], { cwd: consoleDir, env }, (err, stdout, stderr) =>
      resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end(stdin);
  });
}

describe("titan-console inbox file", () => {
  it("round-trips a fixture read from stdin with -: prints the item id and the spool holds the deposit", { timeout: 30_000 }, async () => {
    const fixture = deposit();

    const result = await runCli(["-"], JSON.stringify(fixture));

    expect(result).toEqual({ code: 0, stdout: `${depositItemId(ASKER, "ask-1")}\n`, stderr: "" });
    const { items } = await readSpool(config.inboxDir);
    expect(items).toEqual([expect.objectContaining({ asker: ASKER, summary: fixture.summary, context: fixture.context, options: fixture.options, recommended: fixture.recommended, status: "open" })]);
  });

  it("takes the JSON as an argument, and on a refusal exits 1 without echoing the body", { timeout: 30_000 }, async () => {
    const marker = "do-not-echo-this-value";

    const filed = await runCli([JSON.stringify(deposit({ depositId: "as-arg" }))]);
    const refused = await runCli([JSON.stringify(deposit({ status: "answered", context: marker }))]);

    expect(filed.stdout).toBe(`${depositItemId(ASKER, "as-arg")}\n`);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toMatch(/^inbox\.deposit refused \(HTTP 400\)/);
    expect(refused.stderr).not.toContain(marker);
  });
});

describe("fileDeposit", () => {
  it("dials 127.0.0.1 only, and refuses a redirect rather than re-send the body elsewhere", async () => {
    let elsewhere = 0;
    const target = createServer((_req, res) => {
      elsewhere += 1;
      res.end();
    });
    const redirector = createServer((_req, res) => res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/` }).end());
    await Promise.all([target, redirector].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
    const urls: string[] = [];
    const recording: typeof fetch = (input, init) => {
      urls.push(String(input));
      return fetch(input, init);
    };

    try {
      await expect(fileDeposit((redirector.address() as AddressInfo).port, JSON.stringify(deposit()), recording)).rejects.toThrow(/no console answered/);
      expect(urls).toEqual([`http://127.0.0.1:${(redirector.address() as AddressInfo).port}/rpc/inbox.deposit`]);
      expect(elsewhere).toBe(0);
    } finally {
      await Promise.all([target, redirector].map((server) => new Promise((resolve) => server.close(resolve))));
    }
  });

  it("refuses port 0 before dialling anything", async () => {
    await expect(fileDeposit(0, "{}", () => Promise.reject(new Error("dialled")))).rejects.toThrow(/TITAN_CONSOLE_PORT is 0/);
  });
});
