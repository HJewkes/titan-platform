// TP-4761 S4: a zip reader for the pr-visual artifact, whose bytes the PR's own workflow wrote. It reads the central
// directory only, holds no file on disk, and inflates one named entry at a time under its declared size and a budget
// the whole archive shares, so the archive can make the read refuse but never make it do more work.
import zlib from "node:zlib";

export interface ZipLimits {
  maxEntries: number;
  /** Every inflated byte the archive may yield, summed over the entries read. */
  maxInflatedBytes: number;
}

interface Entry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface ZipReader {
  /** The entry's bytes, or a refusal; an absent name is a refusal, never an empty file. */
  read(name: string): Uint8Array | { refused: string };
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_LENGTH = 22;
const CENTRAL_LENGTH = 46;
const LOCAL_LENGTH = 30;
const MAX_COMMENT = 0xffff;
const ZIP64_MARK = 0xffffffff;
const STORED = 0;
const DEFLATED = 8;

class Refused extends Error {}

function eocdOffset(view: DataView): number {
  const floor = Math.max(0, view.byteLength - EOCD_LENGTH - MAX_COMMENT);
  for (let at = view.byteLength - EOCD_LENGTH; at >= floor; at--) if (view.getUint32(at, true) === EOCD_SIG) return at;
  throw new Refused("not a zip archive");
}

function centralEntry(view: DataView, bytes: Uint8Array, at: number): [string, Entry, number] {
  if (at + CENTRAL_LENGTH > view.byteLength || view.getUint32(at, true) !== CENTRAL_SIG) throw new Refused("corrupt central directory");
  const nameLength = view.getUint16(at + 28, true);
  const next = at + CENTRAL_LENGTH + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  if (next > view.byteLength) throw new Refused("corrupt central directory");
  const name = Buffer.from(bytes.subarray(at + CENTRAL_LENGTH, at + CENTRAL_LENGTH + nameLength)).toString("utf8");
  const entry = { method: view.getUint16(at + 10, true), compressedSize: view.getUint32(at + 20, true), size: view.getUint32(at + 24, true), localOffset: view.getUint32(at + 42, true) };
  if ([entry.compressedSize, entry.size, entry.localOffset].includes(ZIP64_MARK)) throw new Refused("zip64 archives are not read");
  return [name, entry, next];
}

function centralDirectory(bytes: Uint8Array, limits: ZipLimits): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = eocdOffset(view);
  const count = view.getUint16(eocd + 10, true);
  if (count > limits.maxEntries) throw new Refused(`over ${limits.maxEntries} entries`);
  const entries = new Map<string, Entry>();
  let at = view.getUint32(eocd + 16, true);
  for (let index = 0; index < count; index++) {
    const [name, entry, next] = centralEntry(view, bytes, at);
    if (entries.has(name)) throw new Refused("an entry name appears twice");
    entries.set(name, entry);
    at = next;
  }
  return entries;
}

function entryData(bytes: Uint8Array, entry: Entry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + LOCAL_LENGTH > bytes.byteLength || view.getUint32(at, true) !== LOCAL_SIG) throw new Refused("corrupt local header");
  const start = at + LOCAL_LENGTH + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  if (start + entry.compressedSize > bytes.byteLength) throw new Refused("entry runs past the archive");
  return bytes.subarray(start, start + entry.compressedSize);
}

/** The limit sits inside the inflate, so no compression ratio can raise memory past the declared size or the budget. */
function inflated(data: Uint8Array, entry: Entry, budget: number): Uint8Array {
  if (entry.size > budget) throw new Refused("over the inflated byte budget");
  if (entry.method === STORED) return data;
  if (entry.method !== DEFLATED) throw new Refused(`compression method ${entry.method} is not read`);
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
  } catch (error) {
    throw new Refused(error instanceof RangeError ? "inflates past its declared size" : "corrupt entry data");
  }
}

function refusal(error: unknown): { refused: string } {
  if (error instanceof Refused) return { refused: error.message };
  throw error;
}

/** Opens `bytes` as a zip, or refuses it; each `read` draws on one inflated-byte budget for the whole archive. */
export function openZip(bytes: Uint8Array, limits: ZipLimits): ZipReader | { refused: string } {
  let entries: Map<string, Entry>;
  try {
    entries = centralDirectory(bytes, limits);
  } catch (error) {
    return refusal(error);
  }
  let budget = limits.maxInflatedBytes;
  return {
    read(name) {
      const entry = entries.get(name);
      if (entry === undefined) return { refused: "a listed file is not in the archive" };
      try {
        const data = inflated(entryData(bytes, entry), entry, budget);
        if (data.length !== entry.size) return { refused: "an entry is not its declared size" };
        budget -= data.length;
        return data;
      } catch (error) {
        return refusal(error);
      }
    },
  };
}
