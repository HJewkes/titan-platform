import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Runs the helper; rejects on a non-zero exit or when the helper cannot start. */
export type HelperRunner = (file: string, args: readonly string[]) => Promise<string>

const DIALOG_TIMEOUT_MS = 120_000
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_OR_BACKSLASH = /[\0-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\\]/gu
const NAMED: Record<string, string> = { "\t": "\\t", "\r": "\\r", "\\": "\\\\" }

/** Built by `pnpm factory:install` next to the bundled bin. */
export const defaultHelperPath = (): string => join(dirname(fileURLToPath(import.meta.url)), "owner-presence")

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
export const escapeReason = (reason: string): string => reason.replace(CONTROL_OR_BACKSLASH, escapeOne)

/**
 * Asks the owner for Touch ID or their login password. Returns the helper's proof id, or
 * undefined on cancel, a missing helper, a non-zero exit or no GUI session. There is no
 * environment fallback: an agent can set any variable, but cannot satisfy the dialog.
 */
export async function confirmOwner(
  reason: string,
  { run = defaultRunner, helperPath = defaultHelperPath() }: { run?: HelperRunner; helperPath?: string } = {},
): Promise<string | undefined> {
  try {
    const proof = (await run(helperPath, [escapeReason(reason)])).trim()
    return proof === "" ? undefined : proof
  } catch {
    return undefined
  }
}
