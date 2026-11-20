const REGISTRY_TIMEOUT_MS = 10_000;

/** The registry's answer for `name` at `path`, or null on 404; any other non-ok status, and a stall past `timeoutMs`, throw. */
export async function registryGet(name: string, path: string, fetchImpl: typeof fetch, timeoutMs: number = REGISTRY_TIMEOUT_MS): Promise<Response | null> {
  const response = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`registry.npmjs.org answered ${response.status} for ${name}`);
  return response;
}
