import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";
import { canonicalJson } from "./eval-store.js";
import { SLOT_FAMILIES, StylePackSchema, StyleTokensFileSchema, type StylePack, type StyleSlot } from "./style-pack-schema.js";
import { sha256 } from "./workflow/artifacts.js";
import { readYamlDir } from "./yaml-dir.js";

/**
 * Channels whose look a pack must not copy (plan §A.4, W21): their style is the opposite of novel,
 * and agent skills already sell it. Matched on the pack's id and feel, ignoring case and punctuation.
 */
export const IMITATED_CHANNELS = ["3blue1brown", "3b1b", "kurzgesagt", "fireship", "veritasium"] as const;

export class StylePackError extends Error {
  constructor(id: string, problems: readonly string[]) {
    super(`style-packs/${id}.yaml: ${problems.join("; ")}`);
    this.name = "StylePackError";
  }
}

export class UnknownStylePackError extends Error {
  constructor(id: string, known: string[]) {
    super(`unknown style pack ${id}; known: ${known.join(", ")}`);
    this.name = "UnknownStylePackError";
  }
}

/** The pinned token names a pack may pick from. */
export function loadStyleTokens(dir: string = DEFAULT_DOCTRINE_DIR): Set<string> {
  return new Set(StyleTokensFileSchema.parse(JSON.parse(readFileSync(join(dir, "style-tokens.json"), "utf8"))).tokens);
}

const slotEntries = (pack: StylePack): [StyleSlot, string][] =>
  Object.entries(pack.tokens).filter((entry): entry is [StyleSlot, string] => entry[1] !== undefined);

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Every way `pack` breaks the pack rules; empty when it is sound. */
export function stylePackProblems(pack: StylePack, known: ReadonlySet<string>): string[] {
  const unknown = slotEntries(pack).filter(([, token]) => !known.has(token)).map(([slot, token]) => `${slot} names unknown token ${token}`);
  const misfit = slotEntries(pack)
    .filter(([slot, token]) => known.has(token) && !SLOT_FAMILIES[slot].some((prefix) => token.startsWith(prefix)))
    .map(([slot, token]) => `${slot} takes a token from ${SLOT_FAMILIES[slot].join(" or ")}, not ${token}`);
  const text = squash(`${pack.id} ${pack.feel}`);
  const imitation = IMITATED_CHANNELS.filter((name) => text.includes(name)).map((name) => `names ${name}: a pack is our own look`);
  return [...unknown, ...misfit, ...imitation];
}

/** Reads every `style-packs/<id>.yaml` under `dir`; a pack naming a token outside the pinned set, or the wrong kind of token, throws. */
export function loadStylePacks(dir: string = DEFAULT_DOCTRINE_DIR): Map<string, StylePack> {
  const known = loadStyleTokens(dir);
  const packs = readYamlDir(dir, "style-packs", StylePackSchema, (pack) => pack.id);
  for (const pack of packs.values()) {
    const problems = stylePackProblems(pack, known);
    if (problems.length > 0) throw new StylePackError(pack.id, problems);
  }
  return packs;
}

/** The pack `id`; an unknown one throws, listing the known ones, rather than rendering unstyled. */
export function stylePackFor(packs: ReadonlyMap<string, StylePack>, id: string): StylePack {
  const pack = packs.get(id);
  if (pack) return pack;
  throw new UnknownStylePackError(id, [...packs.keys()]);
}

/** The pack's content hash: an edit to its file changes the render stage key. */
export const stylePackSha = (pack: StylePack): string => sha256(canonicalJson(pack));

const kebab = (slot: string): string => slot.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The pack as CSS custom properties, `--pack-<slot>: var(--<token>)`, for a template to apply under its theme class. */
export const stylePackCss = (pack: StylePack): string => slotEntries(pack).map(([slot, token]) => `--pack-${kebab(slot)}: var(--${token});`).join(" ");
