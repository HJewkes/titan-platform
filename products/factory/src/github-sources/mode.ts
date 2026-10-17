import type { Logger } from "@titan-design/daemon";
import type { z } from "zod";
import { GithubConfigSchema, configPath, readConfig } from "../config.js";

export const SOURCES_MODES = ["webhook", "polling"] as const;

type SourcesMode = (typeof SOURCES_MODES)[number];

/** `kill-switch`: the deployment chose webhook but ingress is off, so it runs as polling. */
type SourcesReason = "configured" | "kill-switch";

interface SourcesState {
  configured: SourcesMode;
  effective: SourcesMode;
  reason: SourcesReason;
  intervalMs: number;
}

/** What health shows; `configError` names why the file on disk is not the one in force. */
interface SourcesStatus extends SourcesState {
  configError?: string;
}

export type SourcesReader = () => SourcesStatus;

/** Absent block means the defaults; a contradictory block throws, as it fails the config load. */
export function resolveSources(config: { github?: z.input<typeof GithubConfigSchema> }): SourcesState {
  const github = GithubConfigSchema.parse(config.github ?? {});
  if (github.sources === "webhook" && github.ingress === "on") {
    return { configured: "webhook", effective: "webhook", reason: "configured", intervalMs: github.backstopIntervalMs };
  }
  const reason = github.sources === "webhook" ? "kill-switch" : "configured";
  return { configured: github.sources, effective: "polling", reason, intervalMs: github.pollingIntervalMs };
}

interface SourcesReaderOptions {
  log?: Pick<Logger, "warn">;
}

/**
 * Re-reads the config file on each call, so an edit applies with no restart. An invalid file at construction throws, failing
 * the serve start; after that it keeps the last good state rather than falling to defaults, because a half-saved edit must not
 * silently turn a webhook deployment into a polling one.
 */
export function sourcesReader(env: NodeJS.ProcessEnv, { log }: SourcesReaderOptions = {}): SourcesReader {
  const path = configPath(env);
  let lastGood = resolveSources(readConfig(path) ?? {});
  let loggedError: string | undefined;
  return () => {
    try {
      lastGood = resolveSources(readConfig(path) ?? {});
      loggedError = undefined;
      return lastGood;
    } catch (error) {
      const configError = error instanceof Error ? error.message : String(error);
      if (configError !== loggedError) log?.warn({ configError }, "github sources config invalid; keeping the last good value");
      loggedError = configError;
      return { ...lastGood, configError };
    }
  };
}
