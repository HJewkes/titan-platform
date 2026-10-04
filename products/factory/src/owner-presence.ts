import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Runs the helper; rejects on a non-zero exit or when the helper cannot start. */
export type HelperRunner = (file: string, args: readonly string[]) => Promise<string>

const DIALOG_TIMEOUT_MS = 120_000
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_OR_BACKSLASH = /[\0-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\\]/gu
const NAMED: Record<string, string> = { "\t": "\\t", "\r": "\\r", "\\": "\\\\" }

/** The helper's v4 UUID: anything else on stdout is not a proof, however the helper exited. */
const PROOF = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Built by `pnpm factory:install` into native/build, outside dist, because tsup's clean wipes dist on every build.
 * Resolved from this module's own location; no environment variable or argument can point it elsewhere.
 */
export const defaultHelperPath = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build", "owner-presence")

const defaultRunner: HelperRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", timeout: DIALOG_TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })

function escapeOne(char: string): string {
  const named = NAMED[char]
  if (named !== undefined) return named
  const code = char.codePointAt(0)!
  if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`
  const hex = code.toString(16).toUpperCase()
  return code <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\u{${hex}}`
}

/** Control bytes would redraw or hide what the owner reads in the dialog. */
const escapeReason = (reason: string): string => reason.replace(CONTROL_OR_BACKSLASH, escapeOne)

/**
 * Asks the owner for Touch ID or their login password. Returns the helper's proof id, or
 * undefined on cancel, a missing helper, a non-zero exit, no GUI session or output that is
 * not a UUID. There is no environment fallback: an agent can set any variable, but cannot
 * satisfy the dialog.
 */
export async function confirmOwner(
  reason: string,
  { run = defaultRunner, helperPath = defaultHelperPath() }: { run?: HelperRunner; helperPath?: string } = {},
): Promise<string | undefined> {
  try {
    const proof = (await run(helperPath, [escapeReason(reason)])).trim()
    return PROOF.test(proof) ? proof : undefined
  } catch {
    return undefined
  }
}
