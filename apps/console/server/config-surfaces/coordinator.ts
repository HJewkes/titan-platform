import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { expandHome } from "@titan-design/session-read";
import { BURNDOWN_SURFACE, CHARTER_SURFACE, SEAT_SURFACE, SEAT_WATCHDOG_SURFACE, surfaceRows, type ConfigSurfaces, type SurfaceReader, type SurfaceSpec } from "./catalog.js";

export interface CoordinatorRoots {
  /** Holds `charter.md` and `seats/*.md`; null until `TITAN_CONSOLE_AUTONOMY_DIR` names it, since it has no fixed home. */
  autonomyDir: string | null;
  /** Holds `burndown.config.json` and `seat-watchdog.json`. */
  agentChatDir: string;
}

export const AUTONOMY_DIR_UNSET = "autonomy tree: TITAN_CONSOLE_AUTONOMY_DIR is not set";

/** A config file is small; one past this is listed as a gap rather than parsed. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

export function coordinatorRootsFrom(env: NodeJS.ProcessEnv, home: string): CoordinatorRoots {
  const autonomy = env.TITAN_CONSOLE_AUTONOMY_DIR;
  return {
    autonomyDir: autonomy ? expandHome(autonomy, home) : null,
    agentChatDir: expandHome(env.AGENT_CHAT_HOME ?? "~/.agent-chat", home),
  };
}

interface Target {
  spec: SurfaceSpec;
  surface: string;
  file: string;
}

const EMPTY: ConfigSurfaces = { files: [], rows: [], gaps: [] };

async function autonomyTargets(autonomyDir: string): Promise<{ targets: Target[]; gaps: string[] }> {
  const charter: Target = { spec: CHARTER_SURFACE, surface: "charter", file: path.join(autonomyDir, "charter.md") };
  const seatsDir = path.join(autonomyDir, "seats");
  const names = await readdir(seatsDir).catch(() => null);
  if (names === null) return { targets: [charter], gaps: [`${seatsDir}: not readable`] };
  const seats = names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ spec: SEAT_SURFACE, surface: `seat:${path.basename(name, ".md")}`, file: path.join(seatsDir, name) }));
  return { targets: [charter, ...seats], gaps: [] };
}

async function newestBackup(file: string): Promise<string | null> {
  const prefix = `${path.basename(file)}.bak`;
  const names = await readdir(path.dirname(file)).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(prefix)).sort().at(-1) ?? null;
}

async function readTarget({ spec, surface, file }: Target): Promise<ConfigSurfaces> {
  const info = await stat(file).catch(() => null);
  if (info === null) return { ...EMPTY, gaps: [`${file}: missing`] };
  if (!info.isFile()) return { ...EMPTY, gaps: [`${file}: not a regular file`] };
  if (info.size > MAX_CONFIG_BYTES) return { ...EMPTY, gaps: [`${file}: larger than ${MAX_CONFIG_BYTES} bytes`] };
  const text = await readFile(file, "utf8");
  const { rows, gaps } = surfaceRows(spec, surface, file, text);
  const entry = { surface, kind: spec.kind, group: spec.group, inventory: spec.inventory, file, mtime: info.mtime.toISOString(), newestBackup: await newestBackup(file) };
  return { files: [entry], rows, gaps };
}

/** The charter and seat front matter, the burndown roster and the watchdog's owner switches on this host. */
export function coordinatorSurfaces(roots: CoordinatorRoots): SurfaceReader {
  return async () => {
    const autonomy = roots.autonomyDir === null ? { targets: [], gaps: [AUTONOMY_DIR_UNSET] } : await autonomyTargets(roots.autonomyDir);
    const targets = [
      ...autonomy.targets,
      { spec: BURNDOWN_SURFACE, surface: "burndown", file: path.join(roots.agentChatDir, "burndown.config.json") },
      { spec: SEAT_WATCHDOG_SURFACE, surface: "seat-watchdog", file: path.join(roots.agentChatDir, "seat-watchdog.json") },
    ];
    const answers = await Promise.all(targets.map(readTarget));
    return {
      files: answers.flatMap((answer) => answer.files),
      rows: answers.flatMap((answer) => answer.rows),
      gaps: [...autonomy.gaps, ...answers.flatMap((answer) => answer.gaps)],
    };
  };
}
