import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { EMPTY_SURFACES, surfaceRows, type ConfigFile, type ConfigRow, type ConfigSurfaces, type SurfaceSpec } from "./catalog.js";

/** A config file is small; one past this is listed as a gap rather than parsed. */
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface Target {
  spec: SurfaceSpec;
  surface: string;
  file: string;
}

async function newestBackup(file: string): Promise<string | null> {
  const prefix = `${path.basename(file)}.bak`;
  const names = await readdir(path.dirname(file)).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(prefix)).sort().at(-1) ?? null;
}

/** The file's text and catalog entry, or a gap; `maxBytes` is raised only for a surface read by derivation, never walked whole. */
export async function readSurfaceFile({ spec, surface, file }: Target, maxBytes = MAX_CONFIG_BYTES): Promise<{ text: string; entry: ConfigFile } | { gap: string }> {
  const info = await stat(file).catch(() => null);
  if (info === null) return { gap: `${file}: missing` };
  if (!info.isFile()) return { gap: `${file}: not a regular file` };
  if (info.size > maxBytes) return { gap: `${file}: larger than ${maxBytes} bytes` };
  const text = await readFile(file, "utf8");
  const entry = { surface, kind: spec.kind, group: spec.group, inventory: spec.inventory, file, mtime: info.mtime.toISOString(), newestBackup: await newestBackup(file) };
  return { text, entry };
}

/** Reads one file and walks it through its spec's allowlist. */
export async function readTarget(target: Target): Promise<ConfigSurfaces> {
  const read = await readSurfaceFile(target);
  if ("gap" in read) return { ...EMPTY_SURFACES, gaps: [read.gap] };
  const { rows, gaps } = surfaceRows(target.spec, target.surface, target.file, read.text);
  return { files: [read.entry], rows, gaps };
}

/** Every `*.json` directly in `dir`, sorted, each as one target; hand backups (`x.json.bak-*`) are skipped by the suffix test. */
export async function jsonTargets(dir: string, spec: SurfaceSpec, prefix: string): Promise<{ targets: Target[]; gaps: string[] }> {
  const names = await readdir(dir).catch(() => null);
  if (names === null) return { targets: [], gaps: [`${dir}: not readable`] };
  const targets = names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ spec, surface: `${prefix}:${path.basename(name, ".json")}`, file: path.join(dir, name) }));
  return { targets, gaps: [] };
}

export function derivedRow(surface: string, file: string, field: string, value: unknown): ConfigRow {
  return { surface, file, field, line: 0, hidden: false, value, decisions: [] };
}
