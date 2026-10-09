import fs from "node:fs";

// O_NOFOLLOW makes a symlink swapped in after the lstat fail the open, and O_NONBLOCK keeps
// a FIFO swapped in from hanging it; the fstat then refuses either.
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

type GateRefusal = "not-a-regular-file" | "too-large" | "foreign-owner" | "mode-too-wide" | "hard-linked";

type GatedRead =
  | { status: "missing" }
  | { status: "refused"; reason: GateRefusal }
  // The caller must zero `bytes` once it has parsed them.
  | { status: "read"; bytes: Buffer };

interface GatePolicy {
  maxBytes: number;
  // When set, the file must also be this uid's, owner-only and singly linked: the rules
  // for a credentials file.
  ownerUid?: number;
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function openGated(file: string): number | GateRefusal | null {
  try {
    return fs.openSync(file, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") return "not-a-regular-file";
    throw error;
  }
}

function ownerRefusal(open: fs.Stats, uid: number): GateRefusal | null {
  if (open.uid !== uid) return "foreign-owner";
  if ((open.mode & 0o077) !== 0) return "mode-too-wide";
  // Another name for the same inode may sit outside the config dir, where it was put or
  // will be read under rules this gate cannot see.
  if (open.nlink !== 1) return "hard-linked";
  return null;
}

// Runs on the open descriptor, so what is checked is exactly what would be read.
function gateRefusal(open: fs.Stats, seen: fs.Stats, policy: GatePolicy): GateRefusal | null {
  if (!open.isFile() || open.dev !== seen.dev || open.ino !== seen.ino) return "not-a-regular-file";
  const owner = policy.ownerUid === undefined ? null : ownerRefusal(open, policy.ownerUid);
  if (owner !== null) return owner;
  return open.size > policy.maxBytes ? "too-large" : null;
}

function fillBuffer(fd: number, buffer: Buffer): number {
  let length = 0;
  while (length < buffer.length) {
    const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
    if (n === 0) break;
    length += n;
  }
  return length;
}

// Reads at most one byte past the cap, so a file that grew after the fstat is caught
// without reading it all. The buffer is zeroed on every path that does not hand it back.
function readBounded(fd: number, maxBytes: number): Buffer | null {
  const buffer = Buffer.alloc(maxBytes + 1);
  let length: number;
  try {
    length = fillBuffer(fd, buffer);
  } catch (error) {
    buffer.fill(0);
    throw error;
  }
  if (length <= maxBytes) return buffer.subarray(0, length);
  buffer.fill(0);
  return null;
}

function readFromFd(fd: number, seen: fs.Stats, policy: GatePolicy): GatedRead {
  const reason = gateRefusal(fs.fstatSync(fd), seen, policy);
  if (reason !== null) return { status: "refused", reason };
  const bytes = readBounded(fd, policy.maxBytes);
  return bytes === null ? { status: "refused", reason: "too-large" } : { status: "read", bytes };
}

// lstat, open with O_NOFOLLOW, fstat that descriptor, then read it: no byte is read from a
// file that is not the regular file the lstat saw, or that breaks the policy. Unexpected
// filesystem errors are thrown unredacted; the caller redacts.
export function readGatedFile(file: string, policy: GatePolicy): GatedRead {
  const seen = lstatOrNull(file);
  if (seen === null) return { status: "missing" };
  if (!seen.isFile()) return { status: "refused", reason: "not-a-regular-file" };
  const fd = openGated(file);
  if (fd === null) return { status: "missing" };
  if (typeof fd === "string") return { status: "refused", reason: fd };
  try {
    return readFromFd(fd, seen, policy);
  } finally {
    fs.closeSync(fd);
  }
}
