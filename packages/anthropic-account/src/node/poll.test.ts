import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oauthUsage from "../fixtures/oauth-usage.json" with { type: "json" };
import { CANARY, FAKE_ACCESS_TOKEN, FAKE_JWT, HOUR, NOW, fakeCredentials } from "../fixtures/fake-tokens.js";
import { captureOutput, errorText, makeTempHome, removeTempHome, writeFileWithMode } from "../fixtures/temp-home.js";
import type { AccountProfile } from "../profile.js";
import { CREDENTIALS_FILE } from "./login.js";
import { EXPIRY_MARGIN_MS, MAX_RESPONSE_BYTES, OAUTH_BETA, USAGE_URL, pollAll, pollUsage, type FetchLike } from "./poll.js";
import { usageFilePath } from "./usage-file.js";

const uid = process.getuid?.() ?? 0;

interface Call {
  url: string;
  init: RequestInit;
}

let home: string;
let profile: AccountProfile;
let output: ReturnType<typeof captureOutput>;

beforeEach(() => {
  home = makeTempHome();
  profile = { label: "default", configDir: path.join(home, ".claude") };
  output = captureOutput();
});

afterEach(() => {
  output.restore();
  vi.restoreAllMocks();
  expectNoCanaryInFiles(home);
  removeTempHome(home);
});

function writeCredentials(value: unknown, configDir = profile.configDir, mode = 0o600): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  writeFileWithMode(path.join(configDir, CREDENTIALS_FILE), text, mode);
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

// Case-blind, so a server that lowercases the echoed token into a key is caught too.
function expectCanaryAbsent(text: string): void {
  expect(text.toLowerCase()).not.toContain(CANARY.toLowerCase());
}

function expectNoCanary(...values: unknown[]): void {
  for (const value of values) expectCanaryAbsent(value instanceof Error ? errorText(value) : (JSON.stringify(value) ?? ""));
  expectCanaryAbsent(output.text());
}

// The credentials files hold the canary by design; every other file under the temp home is
// one this package wrote.
function expectNoCanaryInFiles(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name === CREDENTIALS_FILE) continue;
    expectCanaryAbsent(fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"));
  }
}

function poll(fetch: FetchLike, timeoutMs?: number): ReturnType<typeof pollUsage> {
  return pollUsage(profile, { fetch, now: NOW, uid, timeoutMs });
}

describe("pollUsage sends the token only where it belongs", () => {
  it("sends one GET to the usage URL with the token in the Authorization header alone", async () => {
    writeCredentials(fakeCredentials());
    const { fetch, calls } = fakeFetch(() => json(oauthUsage));

    await poll(fetch);

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [Call];
    expect(url).toBe(USAGE_URL);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
    expect(headers.get("anthropic-beta")).toBe(OAUTH_BETA);
    const others = [...headers].filter(([name]) => name !== "authorization");
    expect(JSON.stringify(others)).not.toContain(CANARY);
    expect(JSON.stringify({ ...init, headers: undefined })).not.toContain(CANARY);
  });

  it("returns the mapped reading, labelled and stamped with now", async () => {
    writeCredentials(fakeCredentials());
    const { fetch } = fakeFetch(() => json(oauthUsage));

    const result = await poll(fetch);

    expect(result).toEqual({
      ok: true,
      reading: {
        session_id: "usage-poll",
        written_at: NOW / 1000,
        rate_limits: {
          five_hour: { used_percentage: 23, resets_at: Date.parse("2026-10-08T17:00:00Z") / 1000 },
          seven_day: { used_percentage: 41.5, resets_at: Date.parse("2026-10-12T09:00:00Z") / 1000 },
          seven_day_opus: { used_percentage: 0 },
        },
        source: "oauth-usage",
        account: "default",
      },
    });
    expectNoCanary(result);
  });

  it("leaves a token-shaped label out of the reading", async () => {
    profile = { label: FAKE_JWT, configDir: profile.configDir };
    writeCredentials(fakeCredentials());

    const result = await poll(fakeFetch(() => json(oauthUsage)).fetch);

    expect(result.ok && result.reading.account).toBeUndefined();
    expectNoCanary(result);
  });
});

describe("pollUsage sends nothing when the login cannot be used", () => {
  it.each([
    ["missing", () => fs.mkdirSync(profile.configDir, { recursive: true }), { ok: false, failure: "missing" }],
    ["an empty oauth block", () => writeCredentials({ claudeAiOauth: null }), { ok: false, failure: "missing" }],
    ["expired", () => writeCredentials(fakeCredentials({ expiresAt: NOW - HOUR })), { ok: false, failure: "expired" }],
    [
      "expiring within the margin",
      () => writeCredentials(fakeCredentials({ expiresAt: NOW + EXPIRY_MARGIN_MS })),
      { ok: false, failure: "expired" },
    ],
    [
      "mode 0644",
      () => writeCredentials(fakeCredentials(), profile.configDir, 0o644),
      { ok: false, failure: "refused", reason: "mode-too-wide" },
    ],
    [
      "malformed JSON quoting the token",
      () => writeCredentials(`{"claudeAiOauth":{"accessToken":"${FAKE_ACCESS_TOKEN}",`),
      { ok: false, failure: "refused", reason: "malformed" },
    ],
    [
      "a token that could split the header",
      () => writeCredentials(fakeCredentials({ accessToken: `${FAKE_ACCESS_TOKEN}\r\nx-leak: ${FAKE_ACCESS_TOKEN}` })),
      { ok: false, failure: "refused", reason: "malformed" },
    ],
  ])("%s", async (_name, arrange, expected) => {
    arrange();
    const { fetch, calls } = fakeFetch(() => json(oauthUsage));

    const result = await poll(fetch);

    expect(result).toEqual(expected);
    expect(calls).toHaveLength(0);
    expectNoCanary(result);
  });

  it("refuses a file another user owns before reading it", async () => {
    writeCredentials(fakeCredentials());
    const read = vi.spyOn(fs, "readSync");
    const { fetch, calls } = fakeFetch(() => json(oauthUsage));

    const result = await pollUsage(profile, { fetch, now: NOW, uid: uid + 1 });

    expect(result).toEqual({ ok: false, failure: "refused", reason: "foreign-owner" });
    expect(read).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("reports io, with no message, for a filesystem error on a token-named path", async () => {
    const blocker = path.join(home, FAKE_ACCESS_TOKEN);
    fs.writeFileSync(blocker, "");
    const { fetch, calls } = fakeFetch(() => json(oauthUsage));

    const result = await pollUsage({ label: "x", configDir: blocker }, { fetch, now: NOW, uid });

    expect(result).toEqual({ ok: false, failure: "io" });
    expect(calls).toHaveLength(0);
    expectNoCanary(result);
  });

  it("throws a fixed RangeError for a bad timeout or now, before reading anything", async () => {
    const read = vi.spyOn(fs, "readSync");
    const { fetch } = fakeFetch(() => json(oauthUsage));

    await expect(pollUsage(profile, { fetch, timeoutMs: 0 })).rejects.toThrow(RangeError);
    await expect(pollUsage(profile, { fetch, now: Number.NaN })).rejects.toThrow(RangeError);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("pollUsage against a hostile server", () => {
  beforeEach(() => writeCredentials(fakeCredentials()));

  async function pollWith(respond: (call: Call) => Response | Promise<Response>, timeoutMs?: number) {
    const { fetch, calls } = fakeFetch(respond);
    const result = await poll(fetch, timeoutMs);
    expectNoCanary(result);
    return { result, calls };
  }

  it("drops a token echoed into unknown keys, a window name and a reset time", async () => {
    const { result } = await pollWith(() =>
      json({
        five_hour: { utilization: 12, resets_at: FAKE_ACCESS_TOKEN.slice(0, 40), token: FAKE_ACCESS_TOKEN },
        seven_day: { utilization: 3, resets_at: null },
        seven_day_opus: { utilization: 5, resets_at: FAKE_ACCESS_TOKEN },
        access_token: FAKE_ACCESS_TOKEN,
        canary_echo: { utilization: 1, resets_at: null },
        echo: { authorization: `Bearer ${FAKE_ACCESS_TOKEN}` },
      }),
    );

    expect(result).toEqual({
      ok: true,
      reading: expect.objectContaining({
        rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 3 } },
      }),
    });
  });

  it("ignores a token echoed in response headers", async () => {
    const { result } = await pollWith(() =>
      json(oauthUsage, {
        headers: { "x-echo": `Bearer ${FAKE_ACCESS_TOKEN}`, "set-cookie": `session=${FAKE_ACCESS_TOKEN}` },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("does not follow a redirect whose Location carries the token", async () => {
    const { result, calls } = await pollWith(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://evil.example/?t=${FAKE_ACCESS_TOKEN}` },
        }),
    );

    expect(result).toEqual({ ok: false, failure: "http-302" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a response that a fetch followed to somewhere else", async () => {
    const { result } = await pollWith(() => {
      const response = json(oauthUsage);
      Object.defineProperty(response, "redirected", { value: true });
      Object.defineProperty(response, "url", { value: `https://evil.example/?t=${FAKE_ACCESS_TOKEN}` });
      return response;
    });

    expect(result).toEqual({ ok: false, failure: "network" });
  });

  it.each([401, 403, 429, 500])("reports http-%i without reading an error body that echoes the token", async (status) => {
    const body = { error: { message: `invalid bearer ${FAKE_ACCESS_TOKEN}`, token: FAKE_ACCESS_TOKEN } };

    const { result, calls } = await pollWith(() => json(body, { status }));

    expect(result).toEqual({ ok: false, failure: `http-${status}` });
    expect(calls).toHaveLength(1);
  });

  it("reports network for a rejection whose message, stack and cause carry the token", async () => {
    const { result, calls } = await pollWith(() => {
      const error = new Error(`connect ECONNREFUSED Bearer ${FAKE_ACCESS_TOKEN}`, { cause: FAKE_ACCESS_TOKEN });
      error.stack = `Error: ${FAKE_ACCESS_TOKEN}`;
      throw error;
    });

    expect(result).toEqual({ ok: false, failure: "network" });
    expect(calls).toHaveLength(1);
  });

  it("reports network for a thrown non-Error holding the token", async () => {
    const { result } = await pollWith(() => {
      throw FAKE_ACCESS_TOKEN;
    });

    expect(result).toEqual({ ok: false, failure: "network" });
  });

  it.each([
    ["malformed JSON quoting the token", `{"five_hour": "${FAKE_ACCESS_TOKEN}`],
    ["a bare string", JSON.stringify(FAKE_ACCESS_TOKEN)],
    ["an array", JSON.stringify([FAKE_ACCESS_TOKEN])],
    ["only unknown keys", JSON.stringify({ token: FAKE_ACCESS_TOKEN, extra_usage: { utilization: 1 } })],
    ["a body over the cap", JSON.stringify({ ...oauthUsage, pad: FAKE_ACCESS_TOKEN.repeat(MAX_RESPONSE_BYTES / 64) })],
  ])("reports malformed for %s", async (_name, body) => {
    const { result } = await pollWith(() => new Response(body, { status: 200 }));

    expect(result).toEqual({ ok: false, failure: "malformed" });
  });

  it("reports network when the server never answers within the timeout", async () => {
    const { result } = await pollWith(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      50,
    );

    expect(result).toEqual({ ok: false, failure: "network" });
  });

  it("reports network when the body stalls past the timeout", async () => {
    const { result } = await pollWith(({ init }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"five_hour":`));
          init.signal?.addEventListener("abort", () => controller.error(new Error(FAKE_ACCESS_TOKEN)));
        },
      });
      return new Response(body, { status: 200 });
    }, 50);

    expect(result).toEqual({ ok: false, failure: "network" });
  });

  it("logs nothing on any path", async () => {
    await pollWith(() => json({ error: FAKE_ACCESS_TOKEN }, { status: 500 }));
    await pollWith(() => json(oauthUsage));

    expect(output.text()).toBe("");
  });
});

describe("pollAll", () => {
  const discover = (): { home: string; env: Record<string, string> } => ({ home, env: {} });

  it("polls each discovered profile and writes each reading it got", async () => {
    const agents = path.join(home, ".claude-profiles", "agents");
    writeCredentials(fakeCredentials());
    writeCredentials(fakeCredentials({ expiresAt: NOW - HOUR }), agents);
    const { fetch, calls } = fakeFetch(() => json(oauthUsage));

    const entries = await pollAll({ fetch, now: NOW, uid, discover: discover() });

    expect(entries).toEqual([
      { label: "default", result: expect.objectContaining({ ok: true }), file: usageFilePath(profile.configDir) },
      { label: "agents", result: { ok: false, failure: "expired" } },
    ]);
    expect(calls).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(usageFilePath(profile.configDir), "utf8"));
    expect(written).toMatchObject({ session_id: "usage-poll", account: "default", written_at: NOW / 1000 });
    expect(fs.existsSync(usageFilePath(agents))).toBe(false);
    expectNoCanary(entries);
  });

  it("reports a failed write for one profile and still writes the next", async () => {
    const agents = path.join(home, ".claude-profiles", "agents");
    writeCredentials(fakeCredentials());
    writeCredentials(fakeCredentials(), agents);
    fs.writeFileSync(path.join(profile.configDir, "status-cache"), "");
    const { fetch } = fakeFetch(() => json(oauthUsage));

    const [first, second] = await pollAll({ fetch, now: NOW, uid, discover: discover() });

    expect(first?.writeError).toBeInstanceOf(Error);
    expect(first?.writeError?.cause).toBeUndefined();
    expect(first?.file).toBeUndefined();
    expect(second?.file).toBe(usageFilePath(agents));
    expectNoCanary(first?.writeError);
  });

  it("takes an explicit profile list instead of discovering", async () => {
    writeCredentials(fakeCredentials());
    const { fetch, calls } = fakeFetch(() => json(oauthUsage));

    const entries = await pollAll({ fetch, now: NOW, uid, profiles: [profile], discover: { home: "/nonexistent", env: {} } });

    expect(entries).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});
