import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export const SPILL_PREFIX = 'frame-spill-'

/** A spill from a build that did not name its owner has no pid to test, so only its age says it was abandoned. */
const PIDLESS_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface SweepOptions {
  isAlive?: (pid: number) => boolean
  now?: number
}

/** EPERM means the process exists under another user; only ESRCH proves it gone. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function abandoned(entry: string, { isAlive = processAlive, now = Date.now() }: SweepOptions): Promise<boolean> {
  const pid = /^frame-spill-(\d+)-/.exec(path.basename(entry))?.[1]
  if (pid !== undefined) return !isAlive(Number(pid))
  return now - (await stat(entry)).mtimeMs > PIDLESS_MAX_AGE_MS
}

/**
 * Removes the spills a killed render left in `parent`: those whose owning pid is dead, or that name no pid and are over a
 * day old. Best effort by design, since a failed sweep must not fail the render that asked for it.
 */
export async function sweepStaleSpills(parent: string, options: SweepOptions = {}): Promise<void> {
  const names = await readdir(parent).catch(() => [])
  await Promise.all(
    names
      .filter((name) => name.startsWith(SPILL_PREFIX))
      .map(async (name) => {
        const entry = path.join(parent, name)
        if (await abandoned(entry, options)) await rm(entry, { recursive: true, force: true })
      })
      .map((sweep) => sweep.catch(() => undefined)),
  )
}
