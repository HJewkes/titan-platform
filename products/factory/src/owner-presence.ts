import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Runs the helper with `input` on stdin; rejects on a non-zero exit or when the helper cannot start. */
export type HelperRunner = (file: string, args: readonly string[], input?: Uint8Array) => Promise<string>

/** What lstat reports about one path component; undefined when it does not exist. Any other lstat error propagates. */
export type StatPort = (path: string) => { readonly uid: number; readonly mode: number } | undefined

const DIALOG_TIMEOUT_MS = 120_000
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_OR_BACKSLASH = /[\0-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\\]/gu
const NAMED: Record<string, string> = { "\t": "\\t", "\r": "\\r", "\\": "\\\\" }

/** The helper's v4 UUID: anything else on stdout is not a proof, however the helper exited. */
const PROOF = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const BASE64URL = /^[A-Za-z0-9_-]+$/

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

const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"])

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "UNKNOWN"
}

const defaultStat: StatPort = (path) => {
  try {
    return lstatSync(path, { throwIfNoEntry: false })
  } catch (error) {
    if (ABSENT_CODES.has(errorCode(error))) return undefined
    throw error
  }
}

const defaultReport = (line: string): void => void process.stderr.write(line)

const defaultRunner: HelperRunner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, [...args], { encoding: "utf8", timeout: DIALOG_TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    child.stdin?.end(input)
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

/** The checked helper path, or undefined after reporting why presence fails closed. */
function checkedHelper({ helperPaths = helperSearchOrder(), stat = defaultStat, getuid = () => process.getuid?.(), report = defaultReport }: ConfirmOptions): string | undefined {
  let helper: ReturnType<typeof pickHelper>
  try {
    helper = pickHelper(helperPaths, stat, getuid())
  } catch (error) {
    report(`owner presence refused: lstat of the helper path failed with ${errorCode(error)}\n`)
    return undefined
  }
  if ("refusal" in helper) {
    report(`owner presence refused: ${helper.refusal}\n`)
    return undefined
  }
  return helper.path
}

/**
 * Asks the owner for Touch ID or their login password. Returns the helper's proof id, or
 * undefined on cancel, a missing helper, a helper on a path someone else could replace, a
 * non-zero exit, no GUI session or output that is not a UUID. The path is checked with
 * lstat before each run. There is no environment fallback: an agent can set any variable,
 * but cannot satisfy the dialog.
 */
export async function confirmOwner(reason: string, options: ConfirmOptions = {}): Promise<string | undefined> {
  const helper = checkedHelper(options)
  if (helper === undefined) return undefined
  try {
    const proof = (await (options.run ?? defaultRunner)(helper, [escapeReason(reason)])).trim()
    return PROOF.test(proof) ? proof : undefined
  } catch {
    return undefined
  }
}

/** A DER ECDSA P-256 signature is a SEQUENCE (0x30) of two INTEGERs, 8 to 72 bytes in all. */
function isDerSignature(text: string): boolean {
  if (!BASE64URL.test(text)) return false
  const der = Buffer.from(text, "base64url")
  return der.length >= 8 && der.length <= 72 && der[0] === 0x30
}

/**
 * Signs `statement` with the owner's Secure Enclave key after the same dialog as confirmOwner,
 * with the escaped `reason` in it. Returns the base64url DER ECDSA P-256 SHA-256 signature over
 * the exact bytes, or undefined on cancel, a missing key, the same helper path refusals, no GUI
 * session or output that is not a DER signature. The verifier, not this function, decides
 * whether the signature is the owner's.
 */
export async function signStatement(statement: Uint8Array, reason: string, options: ConfirmOptions = {}): Promise<string | undefined> {
  const helper = checkedHelper(options)
  if (helper === undefined) return undefined
  try {
    const signature = (await (options.run ?? defaultRunner)(helper, ["sign", "--", escapeReason(reason)], statement)).trim()
    return isDerSignature(signature) ? signature : undefined
  } catch {
    return undefined
  }
}
