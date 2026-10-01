import { z } from "zod";

/** Strict rejects unknown keys and is used on write; loose keeps them and is used on read. */
export type SpecParseMode = "strict" | "loose";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const SPEC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** An exact id: lowercase, no spaces or brackets, at least one digit, never a moving `-latest` tag. */
export const MODEL_ID_PATTERN = /^(?!.*-latest$)(?=[^\d]*\d)[a-z0-9][a-z0-9.-]*$/;

export const nonempty = z.string().min(1);
export const sha256 = z.string().regex(SHA256_PATTERN);
export const specId = z.string().regex(SPEC_ID_PATTERN);
export const semver = z.string().regex(SEMVER_PATTERN);
export const count = z.number().int().nonnegative();
export const usd = z.number().nonnegative();
export const fraction = z.number().min(0).max(1);
export const timestamp = z.iso.datetime({ offset: true });
export const visibility = z.enum(["public", "private"]);

/** A JSON Schema document; its own keywords stay open in both modes. */
export const jsonSchema = z.record(z.string(), z.unknown());

/** Repo-relative and forward-only, so a committed spec never names a machine path. */
export const relativePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !path.startsWith("~") && !/^[A-Za-z]:/.test(path), "path must be relative")
  .refine((path) => !path.includes("\\"), "path must use forward slashes")
  .refine((path) => !path.split("/").includes(".."), "path must not climb out of the spec root");

export function objectFor(mode: SpecParseMode) {
  return mode === "strict" ? z.strictObject : z.looseObject;
}

export function modelId(mode: SpecParseMode) {
  if (mode === "loose") return nonempty;
  return nonempty.regex(MODEL_ID_PATTERN, "model must be an exact id; resolve aliases such as sonnet or sonnet[1m] before hashing");
}

export function unitRef(mode: SpecParseMode) {
  return objectFor(mode)({ id: specId, version: semver });
}

export function promptRef(mode: SpecParseMode) {
  return objectFor(mode)({ path: relativePath, sha256 });
}
