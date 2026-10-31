import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isRecord } from "@titan-design/rpc-protocol/narrow";

/** O_NOFOLLOW refuses a final-component symlink; O_NONBLOCK keeps a FIFO from blocking the open. */
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Why a file was refused, phrased to follow its name in a message. */
export class FileRefused extends Error {}

async function openNoFollow(path: string) {
  try {
    return await open(path, FLAGS);
  } catch (error) {
    if (isRecord(error) && error.code === "ELOOP") throw new FileRefused("is a symlink");
    throw error;
  }
}

/**
 * Reads a regular file through one descriptor: type and size come from fstat on that descriptor, and the read is
 * bounded by that size. A path swapped for a symlink after an earlier check is refused at open, and a file that
 * grows after fstat is refused rather than read without limit.
 */
export async function readRegularFile(path: string, limit: number): Promise<Buffer> {
  const handle = await openNoFollow(path);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FileRefused("is not a regular file");
    if (info.nlink > 1) throw new FileRefused(`has ${info.nlink} links; a hardlinked file is refused`);
    if (info.size > limit) throw new FileRefused(`is larger than maxOutputBytes (${limit})`);
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > info.size) throw new FileRefused("changed while it was read");
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}
