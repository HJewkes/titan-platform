import { mkdir, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

export type Sink = (index: number, png: Buffer) => Promise<void>
export type Range = [from: number, to: number]

/** One chunk's frames that cannot reach the sink yet: PNGs in one append-only file, their places in memory. */
class ChunkSpill {
  private readonly places = new Map<number, { offset: number; length: number }>()
  private size = 0
  private opened: Promise<{ file: string; handle: FileHandle }> | undefined

  constructor(private readonly directory: () => Promise<string>, private readonly name: string) {}

  private async open() {
    const file = path.join(await this.directory(), this.name)
    return { file, handle: await open(file, 'a+') }
  }

  async append(index: number, png: Buffer): Promise<void> {
    const { handle } = await (this.opened ??= this.open())
    await handle.appendFile(png)
    this.places.set(index, { offset: this.size, length: png.length })
    this.size += png.length
  }

  async take(index: number): Promise<Buffer | undefined> {
    const place = this.places.get(index)
    if (!place || !this.opened) return undefined
    this.places.delete(index)
    const { handle } = await this.opened
    const { bytesRead, buffer } = await handle.read(Buffer.allocUnsafe(place.length), 0, place.length, place.offset)
    if (bytesRead !== place.length) throw new Error(`spill read of frame ${index} returned ${bytesRead} of ${place.length} bytes`)
    return buffer
  }

  async remove(): Promise<void> {
    const opened = await this.opened?.catch(() => undefined)
    this.opened = undefined
    if (!opened) return
    await opened.handle.close()
    await rm(opened.file, { force: true })
  }
}

/**
 * Hands frames to `sink` strictly in index order however the workers interleave. Only the chunk holding the next
 * frame stays in memory, and its worker waits on the sink; every later chunk appends to its own spill file, because
 * contiguous chunks leave all of them waiting on the head chunk. A worker therefore holds at most the frame it is
 * emitting, whatever the sink's speed. One chunk never touches disk.
 */
export class OrderedSink {
  private readonly pending: { to: number; spill: ChunkSpill }[]
  private readonly held = new Map<number, Buffer>()
  private readonly aborted: Promise<never>
  private rejectAborted: (error: unknown) => void = () => undefined
  private failure: { error: unknown } | undefined
  private next = 0
  private draining = Promise.resolve()
  private directory: Promise<string> | undefined

  constructor(ranges: readonly Range[], private readonly sink: Sink, private readonly spillParent: string) {
    this.pending = ranges.map(([, to], k) => ({ to, spill: new ChunkSpill(() => this.spillDirectory(), `chunk-${k}.pngs`) }))
    this.aborted = new Promise((_, reject) => (this.rejectAborted = reject))
    this.aborted.catch(() => undefined)
  }

  private spillDirectory(): Promise<string> {
    return (this.directory ??= mkdir(this.spillParent, { recursive: true }).then(() => mkdtemp(path.join(this.spillParent, 'frame-spill-'))))
  }

  private async nextFrame(): Promise<Buffer | undefined> {
    if (this.failure) return undefined
    const png = this.held.get(this.next)
    this.held.delete(this.next)
    return png ?? this.pending[0]?.spill.take(this.next)
  }

  private async drain(): Promise<void> {
    for (let png = await this.nextFrame(); png; png = await this.nextFrame()) {
      await this.sink(this.next++, png)
      const [head] = this.pending
      if (head && this.next === head.to) await this.pending.shift()?.spill.remove()
    }
  }

  private pump(): Promise<void> {
    this.draining = this.draining.then(() => this.drain())
    this.draining.catch(this.abort)
    return this.draining
  }

  /** Resolves once the frame is on its spill file or through the sink; rejects once the capture has failed. */
  readonly emit = async (index: number, png: Buffer): Promise<void> => {
    if (this.failure) throw this.failure.error
    const chunk = this.pending.find(({ to }) => index < to)
    if (chunk && chunk !== this.pending[0]) {
      await chunk.spill.append(index, png)
      void this.pump()
      return
    }
    this.held.set(index, png)
    await Promise.race([this.aborted, this.pump()])
  }

  /** The first failure wins and releases every worker waiting on the sink, however long the sink stalls. */
  readonly abort = (error: unknown): void => {
    this.failure ??= { error }
    this.rejectAborted(this.failure.error)
  }

  /** Settles once everything handed in has reached the sink. `aborted` goes first: a failure outranks a chain already settled. */
  drained(): Promise<void> {
    return Promise.race([this.aborted, this.draining])
  }

  /** Call only once every worker has stopped: it deletes the files they append to. */
  async close(): Promise<void> {
    await Promise.all(this.pending.map(({ spill }) => spill.remove()))
    const directory = await this.directory?.catch(() => undefined)
    if (directory) await rm(directory, { recursive: true, force: true })
  }
}
