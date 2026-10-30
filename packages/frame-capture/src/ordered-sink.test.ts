import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'vitest'
import { OrderedSink, type Range, type Sink } from './ordered-sink.js'

const FRAME_BYTES = 1024
const RANGES: Range[] = [[0, 4], [4, 8], [8, 12]]
const ALL_FRAMES = Array.from({ length: 12 }, (_, i) => i)

/** Every frame's bytes differ, so a frame read back from the wrong offset cannot pass as the right one. */
const png = (index: number) => Buffer.alloc(FRAME_BYTES, index + 1)

let parent: string

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), 'ordered-sink-'))
})

afterEach(() => rmSync(parent, { recursive: true, force: true }))

/** A sink that holds its next frame until `release`; `calls` lists what it was handed. */
function gatedSink() {
  const calls: number[] = []
  let open = (): void => undefined
  const gate = new Promise<void>((resolve) => (open = resolve))
  const sink: Sink = async (index) => {
    calls.push(index)
    await gate
  }
  return { calls, sink, release: () => open() }
}

/** A worker sweeping its chunk, which never starts a frame before the last one's emit resolved. */
async function sweep(ordered: OrderedSink, [from, to]: Range, onWaiting?: (delta: number) => void) {
  for (let i = from; i < to; i++) {
    onWaiting?.(1)
    await ordered.emit(i, png(i)).finally(() => onWaiting?.(-1))
  }
}

const spilledBytes = () =>
  readdirSync(parent, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((sum, entry) => sum + statSync(path.join(entry.parentPath, entry.name)).size, 0)

describe('OrderedSink', () => {
  // Mutations: ChunkSpill.append keeps the PNG in a Map instead of the file (nothing on disk); take reads at offset 0
  // (wrong bytes); emit stops waiting on the sink for the head chunk (the head worker runs on while the sink stalls).
  test('a stalled head chunk spills the later chunks, holds one frame, then drains identical bytes in order', async () => {
    const { calls, sink, release } = gatedSink()
    const received: Buffer[] = []
    const ordered = new OrderedSink(RANGES, async (i, buf) => (received.push(buf), sink(i, buf)), parent)
    const [head, ...rest] = RANGES.map((range) => sweep(ordered, range))

    await Promise.all(rest)
    const stalled = { calls: [...calls], spilled: spilledBytes() }
    release()
    await head
    await ordered.drained()

    assert.deepEqual(stalled, { calls: [0], spilled: 8 * FRAME_BYTES })
    assert.deepEqual(calls, ALL_FRAMES)
    assert.ok(received.every((buf, i) => buf.equals(png(i))), 'a frame came back with other bytes')
  })

  // Mutation: emit resolves without waiting on the sink; the head worker piles its whole chunk into memory.
  test('a sink slower than capture leaves at most one frame per worker waiting in memory', async () => {
    let waiting = 0
    let peak = 0
    const track = (delta: number) => (peak = Math.max(peak, (waiting += delta)))
    const ordered = new OrderedSink(RANGES, () => new Promise((resolve) => setTimeout(resolve, 1)), parent)

    await Promise.all(RANGES.map((range) => sweep(ordered, range, track)))
    await ordered.drained()

    assert.ok(peak <= RANGES.length, `${peak} frames waited at once`)
  })

  // Mutation: the sink hands a finished chunk on without removing its spill; the first chunk's file outlives its frames.
  test('a chunk that has drained gives its disk back while the next one drains', async () => {
    const seen: number[] = []
    const ordered = new OrderedSink(RANGES, async (i) => {
      if (i === 8) seen.push(spilledBytes())
    }, parent)
    await sweep(ordered, RANGES[1] as Range)
    await sweep(ordered, RANGES[2] as Range)

    await sweep(ordered, RANGES[0] as Range)
    await ordered.drained()

    assert.deepEqual(seen, [4 * FRAME_BYTES])
  })

  // Mutations: pump drops its abort handler (the capture never hears of the failure); close leaves the directory.
  test('a sink failure rejects every worker and close removes the spill', async () => {
    const ordered = new OrderedSink(RANGES, async () => {
      throw new Error('encoder gone')
    }, parent)

    const workers = await Promise.allSettled(RANGES.map((range) => sweep(ordered, range)))
    await assert.rejects(ordered.drained(), /^Error: encoder gone$/)
    await ordered.close()

    assert.deepEqual(workers.map(({ status }) => status), ['rejected', 'rejected', 'rejected'])
    assert.deepEqual(readdirSync(parent), [])
  })

  // Mutation: emit waits on the sink alone; the head worker hangs on a stalled sink and the capture never rejects.
  test('a worker failure releases a worker stalled on the sink and close removes the spill', async () => {
    const { sink } = gatedSink()
    const ordered = new OrderedSink(RANGES, sink, parent)
    const [head, chunk1] = RANGES.map((range) => sweep(ordered, range))
    await chunk1

    ordered.abort(new Error('page crashed'))
    await assert.rejects(Promise.resolve(head), /^Error: page crashed$/)
    await assert.rejects(ordered.drained(), /^Error: page crashed$/)
    await ordered.close()

    assert.deepEqual(readdirSync(parent), [])
  })

  // Mutation: emit spills whatever is not the next frame; a sequential capture then writes a file when the sink lags.
  test('one chunk writes nothing to disk, even with the sink stalled', async () => {
    const { sink, release } = gatedSink()
    const ordered = new OrderedSink([[0, 3]], sink, parent)

    const worker = sweep(ordered, [0, 3])
    await new Promise((resolve) => setTimeout(resolve, 5))
    const during = readdirSync(parent)
    release()
    await worker
    await ordered.drained()

    assert.deepEqual(during, [])
    assert.deepEqual(readdirSync(parent), [])
  })
})
