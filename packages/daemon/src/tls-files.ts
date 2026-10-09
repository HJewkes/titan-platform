/**
 * The certificate and key behind the remote listener's TLS, such as a pair from
 * `tailscale cert`. Both are checked before anything binds, so a bad pair never half-starts a
 * daemon, and re-read when either file changes, because those certificates expire in about 90
 * days and renewal rewrites them in place.
 */
import { X509Certificate, createPrivateKey } from "node:crypto";
import fs from "node:fs";

export interface RemoteTlsOptions {
  /** PEM certificate chain. Every name the listener answers to must be on it. */
  certFile: string;
  /** PEM private key. Owned by this user and readable by no one else, like the token file. */
  keyFile: string;
}

/** The pair cannot be served. The message names the file and never contains key material. */
export class TlsFileError extends Error {
  constructor(readonly file: string, detail: string, options?: ErrorOptions) {
    super(`TLS file ${file} refused: ${detail}`, options);
    this.name = "TlsFileError";
  }
}

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

export interface TlsFileTracker {
  /** The pair checked at creation or at the last successful reload. */
  current(): TlsMaterial;
  /**
   * Null while neither file has changed. After a change it returns the new pair, or throws
   * {@link TlsFileError} and keeps the last good pair, retrying on the next call.
   */
  reload(): TlsMaterial | null;
}

/** Throws {@link TlsFileError} now when a file is missing, unreadable, mismatched, expired or misnamed. */
export function trackTlsFiles(files: RemoteTlsOptions, names: readonly string[]): TlsFileTracker {
  let snapshot = readPair(files, names);
  return {
    current: () => snapshot.material,
    reload: () => {
      if (pairIdentity(files) === snapshot.identity) return null;
      snapshot = readPair(files, names);
      return snapshot.material;
    },
  };
}

interface PairSnapshot {
  material: TlsMaterial;
  identity: string;
}

function readPair(files: RemoteTlsOptions, names: readonly string[]): PairSnapshot {
  const identity = pairIdentity(files);
  const cert = readFile(files.certFile);
  const key = readFile(files.keyFile, assertPrivate);
  assertServable(files, cert, key, names);
  return { material: { cert, key }, identity };
}

function readFile(file: string, check?: (file: string, stat: fs.Stats) => void): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw new TlsFileError(file, `it cannot be opened (${(err as NodeJS.ErrnoException).code ?? "error"})`, { cause: err });
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new TlsFileError(file, "it is not a regular file");
    check?.(file, stat);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function assertPrivate(file: string, stat: fs.Stats): void {
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new TlsFileError(file, `it is owned by uid ${stat.uid}, not ${uid}`);
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new TlsFileError(file, `mode ${mode.toString(8).padStart(4, "0")} is readable by group or others; chmod 600 it`);
  }
}

function assertServable(files: RemoteTlsOptions, cert: Buffer, key: Buffer, names: readonly string[]): void {
  const x509 = parse(files.certFile, () => new X509Certificate(cert));
  const privateKey = parse(files.keyFile, () => createPrivateKey(key));
  if (!x509.checkPrivateKey(privateKey)) throw new TlsFileError(files.keyFile, "it is not the key of the certificate");
  const now = Date.now();
  if (now < Date.parse(x509.validFrom) || now >= Date.parse(x509.validTo)) {
    throw new TlsFileError(files.certFile, `it is valid only from ${x509.validFrom} to ${x509.validTo}`);
  }
  const uncovered = names.find((name) => x509.checkHost(name, { wildcards: true, subject: "default" }) === undefined);
  if (uncovered !== undefined) throw new TlsFileError(files.certFile, `it does not cover the name "${uncovered}"`);
}

function parse<T>(file: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw new TlsFileError(file, "it is not valid PEM", { cause: err });
  }
}

/** Inode first: renewal by rename can keep the size and even the mtime. A vanished file reads as a change. */
function pairIdentity(files: RemoteTlsOptions): string {
  return [files.certFile, files.keyFile].map(fileIdentity).join("|");
}

function fileIdentity(file: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid].join(":");
  } catch (err) {
    return `missing:${(err as NodeJS.ErrnoException).code ?? "error"}`;
  }
}
