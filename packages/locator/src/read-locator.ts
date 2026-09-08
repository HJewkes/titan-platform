import { promises as fs } from "node:fs";
import type { Locator } from "./locator.js";

/** The exact bytes a locator addresses. Throws if the file is now shorter than the span. */
export async function readLocatorBytes(absolutePath: string, [, byteOffset, byteLength]: Locator): Promise<Buffer> {
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, byteOffset);
    if (bytesRead !== byteLength) {
      throw new Error(`locator ${byteOffset}:${byteLength} runs past the end of ${absolutePath}`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function readLocatorText(absolutePath: string, locator: Locator): Promise<string> {
  return (await readLocatorBytes(absolutePath, locator)).toString("utf8");
}
