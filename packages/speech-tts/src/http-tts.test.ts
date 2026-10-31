import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { loadTtsProfile, resolveTtsConfig } from "./config.js";
import { runTtsConformance } from "./conformance.js";
import { TtsFailedError, TtsUnavailableError } from "./errors.js";
import { httpTts, type HttpTtsOptions } from "./http-tts.js";
import { defaultTtsRegistry } from "./registry.js";
import type { TtsCapabilities } from "./types.js";
import { encodeWav } from "./wav.js";

interface Seen {
  body: Record<string, unknown>;
  headers: IncomingMessage["headers"];
}

const seen: Seen[] = [];
/** Requests that reached the second origin, the target of the cross-origin redirect. */
const otherSeen: Seen[] = [];
let server: Server;
let other: Server;
let base = "";
let otherBase = "";
let closedPortUrl = "";

/** 0.4 s per word divided by speed, so pace and timings are checkable. */
function speak(body: Record<string, unknown>, sampleRate: number) {
  const words = String(body.input ?? body.text ?? "").split(/\s+/).filter(Boolean);
  const slot = 0.4 / (typeof body.speed === "number" ? body.speed : 1);
  const samples = new Float32Array(Math.round(words.length * slot * sampleRate)).fill(0.05);
  const timings = words.map((word, i) => ({ word, start: i * slot, end: i * slot + slot / 2 }));
  return { wav: Buffer.from(encodeWav({ samples, sampleRate })), timings };
}

function flood(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "audio/wav" });
  const block = Buffer.alloc(1 << 20, 0x41);
  const pump = (): void => {
    while (!res.destroyed && res.write(block));
    if (!res.destroyed) res.once("drain", pump);
  };
  pump();
}

const ROUTES: Record<string, (body: Record<string, unknown>, res: ServerResponse, req: IncomingMessage) => void> = {
  "/speech-wav": (body, res) => res.writeHead(200, { "content-type": "audio/wav" }).end(speak(body, 24_000).wav),
  "/speech-json": (body, res) => {
    const { wav, timings } = speak(body, 22_050);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: { audio: wav.toString("base64"), words: timings } }));
  },
  "/busy": (_, res) => res.writeHead(503).end("model loading"),
  "/reject": (_, res) => res.writeHead(400).end("voice not found"),
  "/not-wav": (_, res) => res.writeHead(200).end("hello"),
  "/hang": () => undefined,
  "/redirect": (_, res) => res.writeHead(307, { location: `${otherBase}/speech-wav` }).end(),
  "/flood": (_, res) => flood(res),
  "/echo-key-early": (_, res, req) => res.writeHead(401).end(`key ${String(req.headers["x-api-key"])} rejected`),
  "/echo-key": (_, res, req) => res.writeHead(401).end(`${"x".repeat(5_000)} key ${String(req.headers["x-api-key"])} rejected`),
};

function recordingServer(log: Seen[], route: (body: Record<string, unknown>, res: ServerResponse, req: IncomingMessage) => void): Server {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const parsed: unknown = JSON.parse(raw || "{}");
      const body = isRecord(parsed) ? parsed : {};
      log.push({ body, headers: req.headers });
      route(body, res, req);
    });
  });
}

async function listen(target: Server): Promise<number> {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return address.port;
}

beforeAll(async () => {
  server = recordingServer(seen, (body, res, req) => ROUTES[req.url ?? ""]?.(body, res, req));
  base = `http://127.0.0.1:${await listen(server)}`;
  other = recordingServer(otherSeen, (body, res) => res.writeHead(200).end(speak(body, 24_000).wav));
  otherBase = `http://127.0.0.1:${await listen(other)}`;
  const closed = createServer();
  closedPortUrl = `http://127.0.0.1:${await listen(closed)}/speech-wav`;
  await new Promise((resolve) => closed.close(resolve));
});

afterAll(async () => {
  for (const s of [server, other]) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
});

const TEXT_ONLY: TtsCapabilities = {
  phonemeInput: [],
  wordTimestamps: false,
  speedControl: true,
  voices: [{ id: "alloy", languages: ["en"] }],
  languages: ["en"],
  sampleRate: 24_000,
};
const FULL: TtsCapabilities = { ...TEXT_ONLY, phonemeInput: ["ipa"], wordTimestamps: true, sampleRate: 22_050 };

const wavProvider = (path: string, extra: Partial<HttpTtsOptions> = {}) =>
  httpTts({
    id: "http-stub",
    url: path.startsWith("http") ? path : `${base}${path}`,
    capabilities: TEXT_ONLY,
    request: { body: { input: "{{text}}", voice: "{{voice}}", speed: "{{speed}}" } },
    response: { type: "wav" },
    ...extra,
  });

const jsonProvider = (path: string) =>
  wavProvider(path, {
    capabilities: FULL,
    request: { body: { text: "{{text}}", phonemes: "{{phonemes}}", voice: "{{voice}}", speed: "{{speed}}" } },
    response: { type: "json", audioBase64: "result.audio", words: "result.words" },
  });

// Mutations caught: a refused connection surfaces as a raw TypeError; the deadline does not abort the fetch.
runTtsConformance("httpTts wav body", {
  working: () => wavProvider("/speech-wav"),
  unavailable: () => wavProvider(closedPortUrl),
  hung: () => wavProvider("/hang"),
});

// Mutation caught: the words path is not read, so declared timings never arrive.
runTtsConformance("httpTts json body, full capabilities", {
  working: () => jsonProvider("/speech-json"),
  unavailable: () => jsonProvider(closedPortUrl),
  hung: () => jsonProvider("/hang"),
});

describe("httpTts", () => {
  // Mutation caught: a whole-string placeholder is stringified, so the server reads speed "1.5", not 1.5.
  it("fills the template keeping value types, and drops keys whose value is unset", async () => {
    await wavProvider("/speech-wav").synthesize({ text: "hello there" }, "alloy");
    await wavProvider("/speech-wav").synthesize({ text: "hello" }, "alloy", { speed: 1.5 });

    expect(seen.at(-2)?.body).toEqual({ input: "hello there", voice: "alloy" });
    expect(seen.at(-1)?.body).toEqual({ input: "hello", voice: "alloy", speed: 1.5 });
  });

  // Mutation caught: 503 is reported as a failure, so selection cannot tell a loading engine from a bad request.
  it("reports 503 as unavailable and 400 as failed, with the body in the message", async () => {
    await expect(wavProvider("/busy").synthesize({ text: "hi" }, "alloy")).rejects.toBeInstanceOf(TtsUnavailableError);
    const error = await wavProvider("/reject").synthesize({ text: "hi" }, "alloy").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TtsFailedError);
    expect(String(error)).toContain("HTTP 400: voice not found");
  });

  // Mutation caught: a non-WAV body decodes to empty audio instead of failing.
  it("rejects a body that is not a WAV with TtsFailedError", async () => {
    await expect(wavProvider("/not-wav").synthesize({ text: "hi" }, "alloy")).rejects.toBeInstanceOf(TtsFailedError);
  });

  // Mutation caught: token input sends the plain words, so the engine never sees the declared phonemes.
  it("sends token phonemes through the {{phonemes}} placeholder", async () => {
    await jsonProvider("/speech-json").synthesize({ tokens: [{ text: "live", phonemes: "laɪv" }, { text: "now" }], alphabet: "ipa" }, "alloy");

    expect(seen.at(-1)?.body).toMatchObject({ text: "live now", phonemes: "laɪv now" });
  });
});

describe("httpTts hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Mutation caught: fetch follows redirects, so the key and the text reach whatever origin the server names.
  it("refuses a cross-origin redirect: no header and no body reach the second server", async () => {
    const tts = wavProvider("/redirect", { headers: { "x-api-key": "s3cr3t" } });

    await expect(tts.synthesize({ text: "private words" }, "alloy")).rejects.toThrow(/HTTP 307: redirects are refused/);

    expect(seen.at(-1)?.headers["x-api-key"]).toBe("s3cr3t");
    expect(otherSeen).toEqual([]);
  });

  // Mutations caught: the plain-http check is skipped; every host counts as loopback.
  it("refuses plain http to a remote host at construction, and allows it only by opt-in", () => {
    const remote = (allowInsecureHttp?: boolean) =>
      wavProvider("http://tts.example.com/speak", allowInsecureHttp ? { allowInsecureHttp } : {});

    expect(() => remote()).toThrow("refusing plain http to tts.example.com; use https, or set allowInsecureHttp: true");
    expect(() => remote(true)).not.toThrow();
    expect(() => wavProvider("http://localhost:9/speak")).not.toThrow();
  });

  // Mutation caught: the factory drops the check by passing allowInsecureHttp through as true.
  it("never sends a profile's headers over plain http to a remote host", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const config = resolveTtsConfig({
      env: { KEY: "s3cr3t" },
      profile: {
        version: 1,
        tts: {
          fallback: true,
          providers: {
            remote: { kind: "http", url: "http://tts.example.com/speak", headers: { "x-api-key": "${env:KEY}" }, request: { body: {} }, capabilities: { voices: ["alloy"], sampleRate: 24_000 } },
          },
        },
      },
    });

    expect(() => defaultTtsRegistry().select(config)).toThrow(/remote is misconfigured: remote: refusing plain http to tts.example.com/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Mutation caught: the body is read whole before its size is checked, so an endless body runs to the deadline.
  it("cancels a response body that passes maxOutputBytes while it streams", async () => {
    const started = Date.now();

    const error = await wavProvider("/flood", { maxOutputBytes: 2 * 1024 * 1024 }).synthesize({ text: "hi" }, "alloy", { timeoutMs: 20_000 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TtsFailedError);
    expect(String(error)).toContain("response passed maxOutputBytes (2097152)");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  // Mutations caught: the error body is quoted unredacted; it is quoted whole, however long.
  it("redacts header secrets from an error body and quotes at most about 2 KB of it", async () => {
    const error = await wavProvider("/echo-key", { headers: { "x-api-key": "s3cr3t-key-value" } }).synthesize({ text: "hi" }, "alloy").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TtsFailedError);
    expect(String(error)).not.toContain("s3cr3t-key-value");
    expect(String(error).length).toBeLessThan(2_200);
  });

  // Mutation caught: the error body is cut before redaction, so a secret at the edge leaks in part.
  it("redacts a secret even where the quoted text is cut", async () => {
    const error = await wavProvider("/echo-key-early", { headers: { "x-api-key": "k".repeat(3_000) } }).synthesize({ text: "hi" }, "alloy").catch((e: unknown) => e);

    expect(String(error)).toContain("key [redacted] rejected");
    expect(String(error)).not.toContain("kkkk");
  });
});

describe("OpenAI-compatible /audio/speech mapping fixture", () => {
  const fixture = fileURLToPath(new URL("./fixtures/openai-compatible.profile.json", import.meta.url));

  // Mutations caught: `${env:NAME}` is sent literally; the URL env override is ignored.
  it("sends the vendor body shape with the key expanded from env", async () => {
    const profile = await loadTtsProfile(fixture);
    const env = { EXAMPLE_TTS_API_KEY: "test-key", TITAN_SPEECH_TTS_HOSTED_URL: `${base}/speech-wav` };
    const { provider } = defaultTtsRegistry().select(resolveTtsConfig({ ...(profile ? { profile } : {}), env }));

    const { audio } = await provider.synthesize({ text: "hello world" }, "nova", { speed: 1.25 });

    expect(audio.sampleRate).toBe(24_000);
    expect(seen.at(-1)?.body).toEqual({ model: "tts-1", input: "hello world", voice: "nova", speed: 1.25, response_format: "wav" });
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer test-key");
  });
});
