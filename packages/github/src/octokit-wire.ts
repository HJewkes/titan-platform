import { rateBudget } from "./budget.js";
import { checkRunBody, type CreateCheckRunRequest } from "./check-run-create.js";
import { redactedError, wireOver } from "./gh-cli.js";
import { octokitClient, sharedOctokit, type GitHubClient, type OctokitClientOptions } from "./octokit-client.js";
import { octokitRest } from "./octokit-rest.js";
import type { GitHubWire } from "./port.js";

export interface OctokitWireOptions {
  /** Defaults to the process's shared client, so every wire in a service spends one throttled budget. */
  client?: GitHubClient;
  /** Most recent conditional GETs whose ETag and body are kept. */
  etagCacheSize?: number;
  /** Mints the GitHub App installation token `createCheckRun` posts under, per check run; without it `createCheckRun` refuses. */
  appToken?: () => Promise<string>;
  /** Options for the App identity's own client; its token is always the one `appToken` minted. */
  appClientOptions?: Omit<OctokitClientOptions, "token" | "reauthOn401">;
}

/** The wire a long-running service uses: Octokit with throttling, GET-only retry and ETag reads, behind the same port as `ghCliWire`. */
export function octokitWire(options: OctokitWireOptions = {}): GitHubWire {
  const api = octokitRest(options.client ?? sharedOctokit(), options.etagCacheSize ?? 500);
  return wireOver(api, (repo, request) => postCheckRunAsApp(options, repo, request));
}

/** The App has its own rate limits, so it gets its own client and throttle key, never the user's. */
async function postCheckRunAsApp(options: OctokitWireOptions, repo: string, request: CreateCheckRunRequest): Promise<{ id: number }> {
  if (!options.appToken) throw new Error("createCheckRun needs a GitHub App token provider (OctokitWireOptions.appToken)");
  let token = "";
  try {
    token = await options.appToken();
    const minted = token;
    const client = octokitClient({ throttleId: "app-installation", budget: rateBudget(), ...options.appClientOptions, token: async () => minted, reauthOn401: false });
    return { id: (await octokitRest(client, 0).send<{ id: number }>("POST", `repos/${repo}/check-runs`, {}, checkRunBody(request))).id };
  } catch (error) {
    throw redactedError(error, [token]);
  }
}
