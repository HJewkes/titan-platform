import { assertSupported } from "./capabilities.js";
import { withDeadline } from "./deadline.js";
import { TtsFailedError, TtsUnavailableError } from "./errors.js";
import { errorMessage } from "./guards.js";
import { fillTemplate, readPath, templateValues } from "./http-mapping.js";
import { decodeEngineWav, toSynthesis } from "./synthesis.js";
import type { Synthesis, SynthesizeOptions, TtsCapabilities, TtsInput, TtsProvider } from "./types.js";

/** `wav`: the body is RIFF bytes. `json`: dot paths into the JSON body name each field. */
export type HttpResponseMapping =
  | { type: "wav" }
  | { type: "json"; audioBase64: string; durationS?: string; words?: string; phonemes?: string };

export interface HttpTtsOptions {
  id: string;
  url: string;
  method?: "POST" | "PUT";
  /** Sent as given. Resolve secrets before this point; `resolveTtsConfig` expands `${env:NAME}`. */
  headers?: Readonly<Record<string, string>>;
  capabilities: TtsCapabilities;
  /** A JSON body template; see `fillTemplate` for the placeholders. */
  request: { body: unknown };
  response: HttpResponseMapping;
  timeoutMs?: number;
}

/** Statuses that say the engine is not there right now, as opposed to rejecting this request. */
const UNAVAILABLE_STATUS = new Set([502, 503, 504]);
const BODY_SNIPPET = 300;

async function send(opts: HttpTtsOptions, body: unknown, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(opts.url, {
      method: opts.method ?? "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw new TtsUnavailableError(opts.id, `cannot reach ${new URL(opts.url).origin}: ${errorMessage(cause)}`, { cause });
  }
}

async function checkStatus(opts: HttpTtsOptions, response: Response): Promise<void> {
  if (response.ok) return;
  const detail = `HTTP ${response.status}: ${(await response.text()).slice(0, BODY_SNIPPET)}`;
  if (UNAVAILABLE_STATUS.has(response.status)) throw new TtsUnavailableError(opts.id, detail);
  throw new TtsFailedError(opts.id, detail);
}

async function parseJson(opts: HttpTtsOptions, response: Response, mapping: Extract<HttpResponseMapping, { type: "json" }>): Promise<Synthesis> {
  let doc: unknown;
  try {
    doc = await response.json();
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
  return toSynthesis(opts.id, opts.capabilities, decodeEngineWav(opts.id, new Uint8Array(await response.arrayBuffer())));
}

/** Any HTTP speech endpoint, self-hosted or hosted, described by a request template and a response mapping. */
export function httpTts(opts: HttpTtsOptions): TtsProvider {
  const synthesize = async (input: TtsInput, voice: string, options: SynthesizeOptions = {}): Promise<Synthesis> => {
    assertSupported(opts.id, opts.capabilities, input, voice, options);
    const body = fillTemplate(opts.request.body, templateValues(input, voice, options));
    return withDeadline(opts.id, options.timeoutMs ?? opts.timeoutMs ?? 60_000, options.signal, (signal) =>
      synthesizeOnce(opts, body, signal),
    );
  };
  return { id: opts.id, capabilities: opts.capabilities, synthesize };
}
