import { beforeEach, describe, expect, it, vi } from 'vitest'

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void
const execFile = vi.hoisted(() =>
  vi.fn<(file: string, args: string[], options: Record<string, unknown>, callback: ExecCallback) => void>(),
)
vi.mock('node:child_process', () => ({ execFile }))

import { itermSessionPresent, OSASCRIPT_TIMEOUT_MS } from './iterm.js'
import { PS_TIMEOUT_MS, psProbe } from './launch-check.js'

const UUID = 'ABCD-1234'

/** A runner for an iTerm2 that is up and answers the existence probe with `answer`. */
const runnerAnswering =
  (answer: string | Error) =>
  async (script: string): Promise<string> => {
    if (script.includes('is running')) return 'true'
    if (answer instanceof Error) throw answer
    return answer
  }

const options = (answer: string | Error) => ({ platform: 'darwin' as const, runAppleScript: runnerAnswering(answer) })

const timedOut = (): Error => Object.assign(new Error('Command failed: osascript'), { killed: true, signal: 'SIGKILL', code: null })

describe('itermSessionPresent through an injected runner', () => {
  it('says present when iTerm2 still lists the session', async () => {
    expect(await itermSessionPresent(UUID, options('@@present@@'))).toBe(true)
  })

  it('says gone when iTerm2 lists no such session', async () => {
    expect(await itermSessionPresent(UUID, options('@@gone@@'))).toBe(false)
  })

  it('says unknown for an answer that is neither sentinel', async () => {
    expect(await itermSessionPresent(UUID, options('something else'))).toBeUndefined()
  })

  it('says unknown, never gone, when the probe times out', async () => {
    expect(await itermSessionPresent(UUID, options(timedOut()))).toBeUndefined()
  })

  it('says unknown when iTerm2 is not running', async () => {
    const runAppleScript = async (): Promise<string> => 'false'
    expect(await itermSessionPresent(UUID, { platform: 'darwin', runAppleScript })).toBeUndefined()
  })
})

describe('the real subprocess calls', () => {
  beforeEach(() => {
    execFile.mockReset()
  })

  const succeedWith = (stdout: string): void => {
    execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout, stderr: '' })
    })
  }

  it('gives osascript a timeout and a SIGKILL', async () => {
    succeedWith('true\n')

    await itermSessionPresent(UUID, { platform: 'darwin' })

    const [bin, , execOptions] = execFile.mock.calls[0] ?? []
    expect(bin).toBe('osascript')
    expect(execOptions).toMatchObject({ timeout: OSASCRIPT_TIMEOUT_MS, killSignal: 'SIGKILL' })
    expect(OSASCRIPT_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('gives ps a timeout and a SIGKILL', async () => {
    succeedWith('zsh\n')

    await psProbe('ttys001')

    const [bin, , execOptions] = execFile.mock.calls[0] ?? []
    expect(bin).toBe('ps')
    expect(execOptions).toMatchObject({ timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL' })
    expect(PS_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('rejects, rather than reading as an empty tty, when ps is killed on timeout', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(timedOut())
    })

    await expect(psProbe('ttys001')).rejects.toThrow('Command failed')
  })
})
