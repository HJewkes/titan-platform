import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentHash, readJsonLines } from "@titan-design/locator";
import type { SessionSourceDescriptor } from "./normalized.js";
import { asObject, str } from "./text.js";

export const CODEX_ROLLOUT_FORMAT = "codex-rollout-jsonl";

export interface DiscoverCodexSourcesOptions {
  codexHome?: string;
  namespace: string;
}

export class CodexSourceCollisionError extends Error {
  constructor(readonly sources: readonly SessionSourceDescriptor[]) {
    super(`different Codex rollouts resolve to source ID ${sources[0]?.sourceId ?? "unknown"}`);
    this.name = "CodexSourceCollisionError";
  }
}

export function codexHome(): string {
  return path.join(os.homedir(), ".codex");
}

/** Discover persisted active and archived rollouts without requiring private state databases. */
export async function discoverCodexSources(options: DiscoverCodexSourcesOptions): Promise<SessionSourceDescriptor[]> {
  if (options.namespace.trim().length === 0) throw new TypeError("Codex source namespace must be a nonempty string");
  const home = options.codexHome ?? codexHome();
  const paths = [
    ...(await rolloutPaths(path.join(home, "sessions"))),
    ...(await rolloutPaths(path.join(home, "archived_sessions"))),
  ];
  const found = new Map<string, SessionSourceDescriptor>();
  for (const filePath of paths) {
    const source = await codexSourceFromPath(filePath, options.namespace);
    if (source) await addSource(found, source);
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function codexSourceFromPath(filePath: string, namespace: string): Promise<SessionSourceDescriptor | null> {
  const metadata = await firstMetadata(filePath);
  if (!metadata) return null;
  const nativeId = str(metadata, "id") ?? str(metadata, "thread_id");
  if (!nativeId) return null;
  const historyMode = readHistoryMode(metadata.history_mode);
  return {
    sourceId: codexSourceId(namespace, nativeId, path.basename(filePath)),
    harness: "codex",
    format: CODEX_ROLLOUT_FORMAT,
    formatVersion: str(metadata, "cli_version") ?? str(metadata, "version"),
    path: filePath,
    namespace,
    conversation: { harness: "codex", namespace, nativeId },
    provenance: { kind: "codex-rollout", sessionTreeId: str(metadata, "session_id"), historyMode },
  };
}

export function codexSourceId(namespace: string, nativeId: string, rolloutName: string): string {
  return `codex-rollout:${encodeURIComponent(namespace)}:${encodeURIComponent(nativeId)}:${encodeURIComponent(rolloutName)}`;
}

async function addSource(found: Map<string, SessionSourceDescriptor>, source: SessionSourceDescriptor): Promise<void> {
  const previous = found.get(source.sourceId);
  if (!previous) return void found.set(source.sourceId, source);
  if ((await contentHash(previous.path)) === (await contentHash(source.path))) return;
  throw new CodexSourceCollisionError([previous, source]);
}

async function firstMetadata(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    for await (const line of readJsonLines(filePath)) {
      if (line.text.trim().length === 0) continue;
      const record = asObject(JSON.parse(line.text));
      if (str(record, "type") !== "session_meta") return null;
      return asObject(record?.payload);
    }
  } catch {
    return null;
  }
  return null;
}

async function rolloutPaths(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.map((entry) => pathsForEntry(root, entry)));
  return nested.flat().sort();
}

async function pathsForEntry(root: string, entry: Dirent): Promise<string[]> {
  const candidate = path.join(root, entry.name);
  if (entry.isDirectory()) return rolloutPaths(candidate);
  return entry.isFile() && entry.name.endsWith(".jsonl") ? [candidate] : [];
}

function readHistoryMode(value: unknown): "legacy" | "paginated" | "unknown" {
  return value === "legacy" || value === "paginated" ? value : "unknown";
}
