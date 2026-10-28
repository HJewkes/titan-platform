import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_KINDS } from "@titan-design/render-qa";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_DOCTRINE_DIR } from "../doctrine-load.js";
import { loadTypeProfiles } from "../profile-load.js";
import { sha256 } from "../workflow/artifacts.js";

/** Only a kind render-qa can gate may be named: any other string would gate a kind the inspector never holds as an error. */
const KindSchema = z.enum(ERROR_KINDS);

/** The numeric inspector thresholds a profile may set; viewport and selectors are the page's, not policy. */
export const QaInspectSchema = z.strictObject({
  floorPx: z.number().positive().optional(),
  minContrast: z.number().positive().optional(),
  largeContrast: z.number().positive().optional(),
  largePx: z.number().positive().optional(),
  clearPx: z.number().nonnegative().optional(),
  anchorTolPx: z.number().nonnegative().optional(),
  edgeLabelReachPx: z.number().nonnegative().optional(),
});
type QaInspect = z.infer<typeof QaInspectSchema>;

const TypeOverrideSchema = z.strictObject({
  gate: z.array(KindSchema).default([]),
  info: z.array(KindSchema).default([]),
  inspect: QaInspectSchema.default({}),
});

const GateProfileFileSchema = z.strictObject({
  schema: z.literal("explainer.qa-gate-profile/v1"),
  default: z.strictObject({ gate: z.array(KindSchema), inspect: QaInspectSchema.default({}) }),
  types: z.record(z.string(), TypeOverrideSchema).default({}),
});
type GateProfileFile = z.infer<typeof GateProfileFileSchema>;

/** One video type's QA policy: the kinds that fail the stage and the inspector thresholds, with the file's hash. */
export interface QaGate {
  sha: string;
  gate: string[];
  inspect: QaInspect;
}

/**
 * Whether the caption checks fail the qa stage. Reported until the owner commits to WCAG 2.2 AA, which makes captions
 * (WCAG 1.2.2 Level A) a hard gate; flipping this line is the whole switch.
 */
export const CAPTIONS_GATE = false;
/** Whether an on-screen fact the narration never says fails the qa stage (WCAG 1.2.5 AA); waits on the same answer. */
export const NARRATION_FACTS_GATE = false;

/** Whether the photosensitive flash check (WCAG 2.3.1 Level A) fails the qa stage; reported until the owner commits to WCAG 2.2 AA. */
export const FLASH_GATE = false;

const GATE_PROFILE_FILE = join("qa", "gate-profile.yaml");

/** Parses `gate-profile.yaml`; a kind render-qa does not know, or a type no profile defines, fails the load. */
export function parseGateProfile(text: string, types: ReadonlySet<string>): GateProfileFile {
  const file = GateProfileFileSchema.parse(parse(text));
  const unknown = Object.keys(file.types).filter((type) => !types.has(type));
  if (unknown.length > 0) throw new Error(`${GATE_PROFILE_FILE} overrides ${unknown.join(", ")}, which no types/<type>.yaml defines`);
  return file;
}

/** The policy for `type`: the default's gating kinds plus the type's own, less the kinds it demotes to info. */
export function gateFor(file: GateProfileFile, type: string | undefined): Omit<QaGate, "sha"> {
  const own = type === undefined ? undefined : file.types[type];
  const demoted = new Set<string>(own?.info ?? []);
  const gate = [...new Set([...file.default.gate, ...(own?.gate ?? [])])].filter((kind) => !demoted.has(kind));
  return { gate, inspect: { ...file.default.inspect, ...own?.inspect } };
}

/** Read when the qa spec is built, so an edit to the gate profile re-keys the stage. */
export function loadQaGate(type: string | undefined, dir: string = DEFAULT_DOCTRINE_DIR): QaGate {
  const text = readFileSync(join(dir, GATE_PROFILE_FILE), "utf8");
  const file = parseGateProfile(text, new Set(loadTypeProfiles(dir).keys()));
  return { sha: sha256(text), ...gateFor(file, type) };
}
