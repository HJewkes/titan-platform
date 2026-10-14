import { assertSupported } from "./capabilities.js";
import { withDeadline } from "./deadline.js";
import { TtsFailedError, TtsUnavailableError } from "./errors.js";
import { errorMessage } from "./guards.js";
import { fillTemplate, readPath, templateValues } from "./http-mapping.js";
import { DEFAULT_MAX_OUTPUT_BYTES, errorText } from "./output-limits.js";
import { decodeEngineWav, toSynthesis } from "./synthesis.js";
import type { Synthesis, SynthesizeOptions, TtsCapabilities, TtsInput, TtsProvider } from "./types.js";

/** `wav`: the body is RIFF bytes. `json`: dot paths into the JSON body name each field. */
export type HttpResponseMapping =
  | { type: "wav" }
  | { type: "json"; audioBase64: string; durationS?: string; words?: string; phonemes?: string };

export interface HttpTtsOptions {
  id: string;
  /** `https:`, or `http:` to a loopback host. Any other `http:` URL needs `allowInsecureHttp`. */
  url: string;
  method?: "POST" | "PUT";
  /** Sent as given. Resolve secrets before this point; `resolveTtsConfig` expands `${env:NAME}`. */
  headers?: Readonly<Record<string, string>>;
  capabilities: TtsCapabilities;
  /** A JSON body template; see `fillTemplate` for the placeholders. */
  request: { body: unknown };
  response: HttpResponseMapping;
  timeoutMs?: number;
  /** Past this many response bytes the read is cancelled. Default 64 MB. */
  maxOutputBytes?: number;
  /** Sends headers and text in the clear to a host that is not loopback. Off by default. */
  allowInsecureHttp?: boolean;
  /** Values never quoted in an error. Header values are always added. */
  secrets?: readonly string[];
}

/** Statuses that say the engine is not there right now, as opposed to rejecting this request. */
const UNAVAILABLE_STATUS = new Set([502, 503, 504]);
/** Enough of an error body to explain it; the rest is not read. */
const ERROR_BODY_BYTES = 8_192;

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);

/** Refuses at construction, so a misplaced key is never sent: nothing is fetched from a refused config. */
function assertSafeUrl(id: string, url: string, allowInsecureHttp = false): void {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) throw new TypeError(`${id}: url must be an absolute http(s) URL`);
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname) && !allowInsecureHttp) {
    throw new TypeError(`${id}: refusing plain http to ${parsed.host}; use https, or set allowInsecureHttp: true`);
  }
}

/** Reads at most `limit` bytes. Past it, `onExceed` decides: throw, or keep what was read. */
async function readCapped(response: Response, limit: number, onExceed: () => void): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    if (size + next.value.length > limit) {
      chunks.push(next.value.subarray(0, limit - size));
      await reader.cancel();
      onExceed();
      break;
    }
    chunks.push(next.value);
    size += next.value.length;
  }
  return Buffer.concat(chunks);
}

function readBody(opts: HttpTtsOptions, response: Response): Promise<Uint8Array> {
  const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const tooBig = (): never => {
    throw new TtsFailedError(opts.id, `response passed maxOutputBytes (${limit}); the read was cancelled`);
  };
  if (Number(response.headers.get("content-length") ?? 0) > limit) tooBig();
  return readCapped(response, limit, tooBig);
}

async function send(opts: HttpTtsOptions, body: unknown, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(opts.url, {
      method: opts.method ?? "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(body),
      // A redirect would carry the headers and the text to wherever the server points; refuse instead.
      redirect: "manual",
      signal,
    });
  } catch (cause) {
    throw new TtsUnavailableError(opts.id, `cannot reach ${new URL(opts.url).origin}: ${errorMessage(cause)}`, { cause });
  }
}

async function checkStatus(opts: HttpTtsOptions, response: Response): Promise<void> {
  if (response.ok) return;
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new TtsFailedError(opts.id, `HTTP ${response.status}: redirects are refused; point url at the final endpoint`);
  }
  const raw = Buffer.from(await readCapped(response, ERROR_BODY_BYTES, () => undefined)).toString("utf8");
  const secrets = [...(opts.secrets ?? []), ...Object.values(opts.headers ?? {})];
  const detail = `HTTP ${response.status}: ${errorText(raw, secrets, "head")}`;
  if (UNAVAILABLE_STATUS.has(response.status)) throw new TtsUnavailableError(opts.id, detail);
  throw new TtsFailedError(opts.id, detail);
}

async function parseJson(opts: HttpTtsOptions, response: Response, mapping: Extract<HttpResponseMapping, { type: "json" }>): Promise<Synthesis> {
  const text = Buffer.from(await readBody(opts, response)).toString("utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (cause) {
    throw new TtsFailedError(opts.id, "response body is not JSON", { cause });
  }
  const audio = readPath(doc, mapping.audioBase64);
  if (typeof audio !== "string") throw new TtsFailedError(opts.id, `response has no string at ${mapping.audioBase64}`);
  const field = (path: string | undefined): unknown => (path ? readPath(doc, path) : undefined);
  return toSynthesis(opts.id, opts.capabilities, decodeEngineWav(opts.id, Buffer.from(audio, "base64")), {
    durationS: field(mapping.durationS),
    words: field(mapping.words),
    phonemes: field(mapping.phonemes),
  });
}

async function synthesizeOnce(opts: HttpTtsOptions, body: unknown, signal: AbortSignal): Promise<Synthesis> {
  const response = await send(opts, body, signal);
  await checkStatus(opts, response);
  if (opts.response.type === "json") return parseJson(opts, response, opts.response);
  return toSynthesis(opts.id, opts.capabilities, decodeEngineWav(opts.id, await readBody(opts, response)));
}

/** Any HTTP speech endpoint, self-hosted or hosted, described by a request template and a response mapping. */
export function httpTts(opts: HttpTtsOptions): TtsProvider {
  assertSafeUrl(opts.id, opts.url, opts.allowInsecureHttp);
  const synthesize = async (input: TtsInput, voice: string, options: SynthesizeOptions = {}): Promise<Synthesis> => {
    assertSupported(opts.id, opts.capabilities, input, voice, options);
    const body = fillTemplate(opts.request.body, templateValues(input, voice, options));
    return withDeadline(opts.id, options.timeoutMs ?? opts.timeoutMs ?? 60_000, options.signal, (signal) =>
      synthesizeOnce(opts, body, signal),
    );
  };
  return { id: opts.id, capabilities: opts.capabilities, synthesize };
}
