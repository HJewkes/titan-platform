import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { commandTts, type CommandOutput } from "./command-tts.js";
import type { TtsProviderConfig } from "./config.js";
import { fakeTts } from "./fake-tts.js";
import { isStringArray, isStringRecord } from "./guards.js";
import { httpTts, type HttpResponseMapping } from "./http-tts.js";
import type { PhonemeAlphabet, TtsCapabilities, TtsProvider, TtsVoice } from "./types.js";

/** Builds a provider from its profile entry, throwing TypeError when the entry is malformed. */
export type TtsProviderFactory = (id: string, config: TtsProviderConfig) => TtsProvider;

const isAlphabet = (a: string): a is PhonemeAlphabet => a === "ipa" || a === "misaki";
const isOutput = (o: unknown): o is CommandOutput => o === "stdout-wav" || o === "json";
const isMethod = (m: unknown): m is "POST" | "PUT" => m === "POST" || m === "PUT";

const fail = (id: string, why: string): never => {
  throw new TypeError(`tts.providers.${id}: ${why}`);
};

function parseVoice(id: string, raw: unknown): TtsVoice {
  if (typeof raw === "string") return { id: raw, languages: [] };
  if (!isRecord(raw) || typeof raw.id !== "string") return fail(id, "each voice is a string id or { id, languages }");
  return { id: raw.id, languages: isStringArray(raw.languages) ? raw.languages : [] };
}

function parsePhonemeInput(id: string, raw: unknown): PhonemeAlphabet[] {
  const list = raw ?? [];
  if (!isStringArray(list)) return fail(id, "capabilities.phonemeInput must be an array");
  return list.map((a) => (isAlphabet(a) ? a : fail(id, `capabilities.phonemeInput may hold only ipa, misaki (got ${a})`)));
}

/** Only `voices` and `sampleRate` are required; every other capability defaults to absent. */
export function parseCapabilities(id: string, raw: unknown): TtsCapabilities {
  if (!isRecord(raw)) return fail(id, "needs a capabilities object");
  if (typeof raw.sampleRate !== "number") return fail(id, "capabilities.sampleRate must be a number");
  if (!Array.isArray(raw.voices) || raw.voices.length === 0) return fail(id, "capabilities.voices must list at least one voice");
  return {
    phonemeInput: parsePhonemeInput(id, raw.phonemeInput),
    wordTimestamps: raw.wordTimestamps === true,
    speedControl: raw.speedControl === true,
    voices: raw.voices.map((v: unknown) => parseVoice(id, v)),
    languages: isStringArray(raw.languages) ? raw.languages : [],
    sampleRate: raw.sampleRate,
  };
}

function optionalPositive(id: string, key: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  return typeof v === "number" && v > 0 ? v : fail(id, `${key} must be a positive number`);
}

/** The limits and redaction list every adapter that talks to an outside engine takes. */
function sharedOptions(id: string, config: TtsProviderConfig): { timeoutMs?: number; maxOutputBytes?: number; secrets?: string[] } {
  const { secrets } = config;
  if (secrets !== undefined && !isStringArray(secrets)) return fail(id, "secrets must be an array of strings");
  const timeoutMs = optionalPositive(id, "timeoutMs", config.timeoutMs);
  const maxOutputBytes = optionalPositive(id, "maxOutputBytes", config.maxOutputBytes);
  return {
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxOutputBytes ? { maxOutputBytes } : {}),
    ...(secrets ? { secrets } : {}),
  };
}

export const commandFactory: TtsProviderFactory = (id, config) => {
  const { argv, output, env, cwd } = config;
  if (!isStringArray(argv) || argv.length === 0) return fail(id, "argv must be a non-empty array of strings");
  if (output !== undefined && !isOutput(output)) return fail(id, 'output must be "stdout-wav" or "json"');
  if (env !== undefined && !isStringRecord(env)) return fail(id, "env must map names to strings");
  return commandTts({
    id,
    argv,
    capabilities: parseCapabilities(id, config.capabilities),
    ...(output ? { output } : {}),
    ...(env ? { env } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...sharedOptions(id, config),
  });
};

function parseResponse(id: string, raw: unknown): HttpResponseMapping {
  const mapping = raw ?? { type: "wav" };
  if (isRecord(mapping) && mapping.type === "wav") return { type: "wav" };
  if (!isRecord(mapping) || mapping.type !== "json" || typeof mapping.audioBase64 !== "string") {
    return fail(id, 'response must be { "type": "wav" } or { "type": "json", "audioBase64": "<path>" }');
  }
  const path = (key: string): Record<string, string> => {
    const value = mapping[key];
    return typeof value === "string" ? { [key]: value } : {};
  };
  return { type: "json", audioBase64: mapping.audioBase64, ...path("durationS"), ...path("words"), ...path("phonemes") };
}

export const httpFactory: TtsProviderFactory = (id, config) => {
  const { url, method, headers, request } = config;
  if (typeof url !== "string" || !URL.canParse(url)) return fail(id, "url must be an absolute URL");
  if (config.allowInsecureHttp !== undefined && typeof config.allowInsecureHttp !== "boolean") return fail(id, "allowInsecureHttp must be true or false");
  if (method !== undefined && !isMethod(method)) return fail(id, 'method must be "POST" or "PUT"');
  if (headers !== undefined && !isStringRecord(headers)) return fail(id, "headers must map names to strings");
  if (!isRecord(request) || request.body === undefined) return fail(id, "request.body must be a JSON template");
  return httpTts({
    id,
    url,
    capabilities: parseCapabilities(id, config.capabilities),
    request: { body: request.body },
    response: parseResponse(id, config.response),
    ...(method ? { method } : {}),
    ...(headers ? { headers } : {}),
    ...(config.allowInsecureHttp === true ? { allowInsecureHttp: true } : {}),
    ...sharedOptions(id, config),
  });
};

/** A profile entry of kind `fake` gives a dry run with no engine at all. */
export const fakeFactory: TtsProviderFactory = (id, config) =>
  fakeTts({ id, ...(config.capabilities ? { capabilities: parseCapabilities(id, config.capabilities) } : {}) });
