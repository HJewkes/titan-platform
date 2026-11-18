import { readFile } from "node:fs/promises";
import { appInstallationTokenOverHttp, githubPort, octokitWire, type GitHubPort } from "@titan-design/github";
import type { ReviewCheckConfig } from "../config.js";

/** The App-token port the publish step posts through, writing as `config.login`; the key is read per post, so a missing file fails that post only. */
export function reviewCheckPort(config: ReviewCheckConfig | undefined): GitHubPort | undefined {
  if (!config) return undefined;
  const appToken = async (): Promise<string> => {
    const privateKeyPem = await readFile(config.privateKeyPath, "utf8");
    return (await appInstallationTokenOverHttp({ appId: config.appId, installationId: config.installationId, privateKeyPem, now: Date.now })).token;
  };
  return githubPort(octokitWire({ appToken }), config.login === undefined ? {} : { login: config.login });
}
