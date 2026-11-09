import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { beforeEach, describe, test, vi } from 'vitest'

/** A stand-in ffmpeg: stdin collects frames until `die` is called, after which each write fails with EPIPE. */
class FakeFfmpeg extends EventEmitter {
  readonly frames: Buffer[] = []
  ended = false
  private dead = false
  readonly stdin = new Writable({
    highWaterMark: 4,
    write: (chunk: Buffer, _encoding, callback) => {
      if (!this.dead) {
        this.frames.push(chunk)
        callback()
        return
      }
      callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      setImmediate(() => this.emit('close', 1, null))
    },
    final: (callback) => {
      this.ended = true
      callback()
      setImmediate(() => this.emit('close', 0, null))
    },
  })

  die(): void {
    this.dead = true
  }
}

const spawned: { command: string; args: string[]; child: FakeFfmpeg }[] = []

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    const child = new FakeFfmpeg()
    spawned.push({ command, args, child })
    return child
  },
}))

const { startEncoder } = await import('./encode.js')

function lastSpawn(): { command: string; args: string[]; child: FakeFfmpeg } {
  const last = spawned.at(-1)
  assert.ok(last, 'startEncoder spawned no ffmpeg')
  return last
}

describe('startEncoder', () => {
  beforeEach(() => {
    spawned.length = 0
  })

  // Mutation: the fps or output path is dropped from the ffmpeg arguments.
  test('starting an encoder runs one ffmpeg reading PNGs on stdin at the given rate into the output', () => {
    startEncoder('out.mp4', 30, 'mix.wav')

    const { command, args } = lastSpawn()
    assert.equal(command, 'ffmpeg')
    assert.deepEqual(args.slice(args.indexOf('-framerate'), args.indexOf('-framerate') + 2), ['-framerate', '30'])
    assert.ok(args.includes('mix.wav'))
    assert.equal(args.at(-1), 'out.mp4')
  })

  // Mutation: write resolves without waiting for 'drain' when stdin is full, or drops the frame.
  test('frames written past the stdin buffer all reach ffmpeg in order', async () => {
    const encoder = startEncoder('out.mp4', 30, 'mix.wav')
    const frames = ['frame-0', 'frame-1', 'frame-2'].map((text) => Buffer.from(text))

    for (const frame of frames) await encoder.write(frame)

    assert.deepEqual(lastSpawn().child.frames.map(String), ['frame-0', 'frame-1', 'frame-2'])
  })

  // Mutation: finish resolves before ffmpeg closes, or without ending stdin.
  test('finishing ends stdin and resolves once ffmpeg exits 0', async () => {
    const encoder = startEncoder('out.mp4', 30, 'mix.wav')
    await encoder.write(Buffer.from('frame-0'))

    await encoder.finish()

    assert.equal(lastSpawn().child.ended, true)
  })

  // Mutation: the stdin 'error' listener is removed, so EPIPE is thrown uncaught.
  test('ffmpeg dying mid-write rejects with its exit reason instead of an uncaught EPIPE', async () => {
    const encoder = startEncoder('out.mp4', 30, 'mix.wav')
    await encoder.write(Buffer.from('frame-0'))
    lastSpawn().child.die()

    await assert.rejects(encoder.write(Buffer.from('frame-1')), (error: Error) => {
      assert.equal(error.message, 'ffmpeg exited 1')
      assert.match(String(error.cause), /^Error: write EPIPE$/)
      return true
    })
    await assert.rejects(encoder.finish(), /^Error: ffmpeg exited 1$/)
  })

  // Mutation: the spawn 'error' listener is removed.
  test('ffmpeg failing to start rejects finish with the spawn error', async () => {
    const encoder = startEncoder('out.mp4', 30, 'mix.wav')

    lastSpawn().child.emit('error', new Error('spawn ffmpeg ENOENT'))

    await assert.rejects(encoder.finish(), /^Error: spawn ffmpeg ENOENT$/)
  })
})
