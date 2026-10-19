import { readdir } from "node:fs/promises";
import path from "node:path";
import { EMPTY_SURFACES, joinSurfaces, type ConfigSurfaces, type SurfaceReader } from "./catalog.js";
import { CLAUDE_JSON_SURFACE, CLAUDE_MD_SURFACE, CLAUDE_SETTINGS_SURFACE, namesOnly } from "./specs.js";
import { derivedRow, readSurfaceFile, readTarget } from "./files.js";

/** `.claude.json` keeps every project ever opened, so it outgrows the walked files' cap; it is parsed, never walked. */
const MAX_CLAUDE_JSON_BYTES = 32 * 1024 * 1024;

export interface ClaudeAccounts {
  /** Config directories read as named. */
  dirs: readonly string[];
  /** A directory whose every subdirectory is one more account; null reads `dirs` alone. */
  profilesDir: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The two facts the page may show: how many folders are trusted, and which MCP servers are named, at the top level or per project. */
export function claudeJsonFacts(body: Record<string, unknown>): { trustedFolders: number; mcpServers: string[] } {
  const projects = isRecord(body.projects) ? Object.values(body.projects).filter(isRecord) : [];
  const names = [body.mcpServers, ...projects.map((project) => project.mcpServers)].flatMap(namesOnly);
  return { trustedFolders: projects.filter((project) => project.hasTrustDialogAccepted === true).length, mcpServers: [...new Set(names)].sort() };
}

/** A parse failure is a gap with no parser message, since the message would quote the file. */
async function claudeJson(account: string, dir: string): Promise<ConfigSurfaces> {
  const surface = `claude-json:${account}`;
  const file = path.join(dir, ".claude.json");
  const read = await readSurfaceFile({ spec: CLAUDE_JSON_SURFACE, surface, file }, MAX_CLAUDE_JSON_BYTES);
  if ("gap" in read) return { ...EMPTY_SURFACES, gaps: [read.gap] };
  const body = parsedObject(read.text);
  if (body === null) return { files: [read.entry], rows: [], gaps: [`${file}: not a valid json object`] };
  const facts = claudeJsonFacts(body);
  return { files: [read.entry], rows: [derivedRow(surface, file, "trustedFolders", facts.trustedFolders), derivedRow(surface, file, "mcpServers", facts.mcpServers)], gaps: [] };
}

async function accountDirs({ dirs, profilesDir }: ClaudeAccounts): Promise<{ dirs: string[]; gaps: string[] }> {
  if (profilesDir === null) return { dirs: [...dirs], gaps: [] };
  const entries = await readdir(profilesDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return { dirs: [...dirs], gaps: [`${profilesDir}: not readable`] };
  const profiles = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(profilesDir, entry.name)).sort();
  return { dirs: [...dirs, ...profiles], gaps: [] };
}

function accountSurfaces(dir: string): Promise<ConfigSurfaces>[] {
  const account = path.basename(dir).replace(/^\./, "");
  return [readTarget({ spec: CLAUDE_SETTINGS_SURFACE, surface: `claude-settings:${account}`, file: path.join(dir, "settings.json") }), claudeJson(account, dir)];
}

/** The first "<n> per repo" in the prose, with its 1-based line; nothing else in the file is read out. */
function statedWorktreeCap(text: string): { value: number; line: number } | null {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /\b(\d+) per repo\b/.exec(line);
    if (match?.[1] !== undefined) return { value: Number(match[1]), line: index + 1 };
  }
  return null;
}

/** The home CLAUDE.md's stated worktree cap, the one copy of that value no program reads. */
export function claudeMdSurfaces(file: string): SurfaceReader {
  return async () => {
    const surface = "claude-md";
    const read = await readSurfaceFile({ spec: CLAUDE_MD_SURFACE, surface, file });
    if ("gap" in read) return { ...EMPTY_SURFACES, gaps: [read.gap] };
    const cap = statedWorktreeCap(read.text);
    if (cap === null) return { files: [read.entry], rows: [], gaps: [`${file}: states no per-repo worktree cap`] };
    return { files: [read.entry], rows: [{ ...derivedRow(surface, file, "worktreesPerRepo", cap.value), line: cap.line }], gaps: [] };
  };
}

/** Each Claude Code account's `settings.json` and `.claude.json`. Hook scripts are shown as the commands settings runs. */
export function claudeSurfaces(accounts: ClaudeAccounts): SurfaceReader {
  return async () => {
    const found = await accountDirs(accounts);
    const answer = joinSurfaces(await Promise.all(found.dirs.flatMap(accountSurfaces)));
    return { ...answer, gaps: [...found.gaps, ...answer.gaps] };
  };
}
