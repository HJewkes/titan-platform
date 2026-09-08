import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Write to a sibling temp file, fsync, then rename over the target. The temp
 * file lives in the same directory so the rename stays on one filesystem,
 * which is what makes it atomic on POSIX.
 */
export async function atomicWrite(targetPath: string, content: string | Buffer): Promise<void> {
  const tempPath = path.join(
    path.dirname(targetPath),
    `${path.basename(targetPath)}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`,
  );
  const handle = await fs.open(tempPath, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }
}
