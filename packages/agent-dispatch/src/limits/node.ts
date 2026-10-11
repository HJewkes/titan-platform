import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { LimitsConfigError, parseLimits, type IgnoredEntry, type ParsedLimits } from "./parse.js";
import { grantSchema, type Grant } from "./schema.js";

export interface GrantsFile {
  grants: Grant[];
  /** Lift-question keys already asked, so a restart never asks twice in one window. */
  asked: string[];
  ignored: IgnoredEntry[];
}

const grantsEnvelope = z.object({
  grants: z.array(z.unknown()).optional(),
  asked: z.array(z.string()).optional(),
});

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new LimitsConfigError(`cannot read ${path}: ${(err as Error).message}`, { cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LimitsConfigError(`${path} is not JSON: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Reads a limits block from a path the caller owns. With `key`, the block is that property of
 * the file (a host config); without it, the file is the block. Any failure throws, so the
 * caller closes every pool.
 */
export function loadLimits(path: string, options: { key?: string } = {}): ParsedLimits {
  const json = readJson(path);
  if (options.key === undefined) return parseLimits(json);
  const block = typeof json === "object" && json !== null ? (json as Record<string, unknown>)[options.key] : undefined;
  if (block === undefined) throw new LimitsConfigError(`${path} has no ${options.key} block`);
  return parseLimits(block);
}

/** Reads the grants state file. A missing file means no grants yet; a malformed entry is ignored. */
export function readGrants(path: string): GrantsFile {
  if (!existsSync(path)) return { grants: [], asked: [], ignored: [] };
  const envelope = grantsEnvelope.safeParse(readJson(path));
  if (!envelope.success) throw new LimitsConfigError(`${path} refused: ${z.prettifyError(envelope.error)}`);
  const grants: Grant[] = [];
  const ignored: IgnoredEntry[] = [];
  (envelope.data.grants ?? []).forEach((value, index) => {
    const result = grantSchema.safeParse(value);
    if (result.success) grants.push(result.data);
    else ignored.push({ index, reason: z.prettifyError(result.error) });
  });
  return { grants, asked: envelope.data.asked ?? [], ignored };
}
