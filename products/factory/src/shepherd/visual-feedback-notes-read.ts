// TP-5410: the one reader of the console rounds dir for the notes sweep. Like the other readers of that dir it refuses a
// symlink, a FIFO or any non-regular file and caps the size, so planted text never becomes tasks and a FIFO cannot hang the sweep.
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_BYTES = 1024 * 1024;
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The file's text, or undefined when it is absent, a symlink, not a regular file, oversized or unreadable. */
export async function readRegularText(file: string): Promise<string | undefined> {
  const handle = await open(file, OPEN_FLAGS).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const stats = await handle.stat();
    return stats.isFile() && stats.size <= MAX_BYTES ? await handle.readFile("utf8") : undefined;
  } finally {
    await handle.close();
  }
}
