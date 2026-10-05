import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Runs the helper; rejects on a non-zero exit or when the helper cannot start. */
export type HelperRunner = (file: string, args: readonly string[]) => Promise<string>

/** What lstat reports about one path component; undefined when it does not exist or cannot be read. */
export type StatPort = (path: string) => { readonly uid: number; readonly mode: number } | undefined

const DIALOG_TIMEOUT_MS = 120_000
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_OR_BACKSLASH = /[\0-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\\]/gu
const NAMED: Record<string, string> = { "\t": "\\t", "\r": "\\r", "\\": "\\\\" }

/** The helper's v4 UUID: anything else on stdout is not a proof, however the helper exited. */
const PROOF = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000
const GROUP_OR_OTHER_WRITE = 0o022

/**
 * Built by `pnpm factory:install` into native/build, outside dist, because tsup's clean wipes dist on every build.
 * Resolved from this module's own location; no environment variable or argument can point it elsewhere.
 */
export const defaultHelperPath = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build", "owner-presence")

/** Only root can write here, so an agent running as the owner cannot swap the helper once it is installed. */
export const ROOT_HELPER_PATH = "/usr/local/libexec/titan-factory/owner-presence"

/** Fixed in code: once the root install exists it is the only candidate, even when it then fails the path check. */
export const helperSearchOrder = (): readonly string[] => [ROOT_HELPER_PATH, defaultHelperPath()]

const defaultStat: StatPort = (path) => {
  try {
    return lstatSync(path, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

const defaultRunner: HelperRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", timeout: DIALOG_TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })

/** The path and every parent up to /, helper first. */
function pathComponents(path: string): string[] {
  const components = [path]
  for (let parent = dirname(path); parent !== components.at(-1); parent = dirname(parent)) components.push(parent)
  return components
}

/**
 * Why `path` is not a helper only root or the owner can replace, or undefined when it is. Every component must exist,
 * be no symlink, be owned by root or `uid` and carry no group or other write bit; the helper must be a regular file.
 */
function helperPathRefusal(path: string, stat: StatPort, uid: number | undefined): string | undefined {
  if (!isAbsolute(path)) return `${path} is not an absolute path`
  if (uid === undefined) return "no OS user id to check the helper's owner against"
  for (const component of pathComponents(path)) {
    const info = stat(component)
    if (info === undefined) return `${component} is missing`
    if ((info.mode & S_IFMT) === S_IFLNK) return `${component} is a symlink`
    if (info.uid !== 0 && info.uid !== uid) return `${component} is owned by uid ${info.uid}, not root or uid ${uid}`
    if ((info.mode & GROUP_OR_OTHER_WRITE) !== 0) return `${component} is group or other writable`
    if (component === path && (info.mode & S_IFMT) !== S_IFREG) return `${component} is not a regular file`
  }
  return undefined
}

/** The first candidate that exists, if its whole path passes the check; otherwise why presence fails closed. */
function pickHelper(candidates: readonly string[], stat: StatPort, uid: number | undefined): { path: string } | { refusal: string } {
  const path = candidates.find((candidate) => stat(candidate) !== undefined)
  if (path === undefined) return { refusal: `no helper at ${candidates.join(" or ")}` }
  const refusal = helperPathRefusal(path, stat, uid)
  return refusal === undefined ? { path } : { refusal }
}

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

interface ConfirmOptions {
  run?: HelperRunner
  helperPaths?: readonly string[]
  stat?: StatPort
  getuid?: () => number | undefined
  report?: (line: string) => void
}

/**
 * Asks the owner for Touch ID or their login password. Returns the helper's proof id, or
 * undefined on cancel, a missing helper, a helper on a path someone else could replace, a
 * non-zero exit, no GUI session or output that is not a UUID. The path is checked with
 * lstat before each run. There is no environment fallback: an agent can set any variable,
 * but cannot satisfy the dialog.
 */
export async function confirmOwner(
  reason: string,
  { run = defaultRunner, helperPaths = helperSearchOrder(), stat = defaultStat, getuid = () => process.getuid?.(), report = (line) => void process.stderr.write(line) }: ConfirmOptions = {},
): Promise<string | undefined> {
  const helper = pickHelper(helperPaths, stat, getuid())
  if ("refusal" in helper) {
    report(`owner presence refused: ${helper.refusal}\n`)
    return undefined
  }
  try {
    const proof = (await run(helper.path, [escapeReason(reason)])).trim()
    return PROOF.test(proof) ? proof : undefined
  } catch {
    return undefined
  }
}
