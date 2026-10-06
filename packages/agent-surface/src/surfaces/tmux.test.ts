import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LaunchPlan, SurfaceName } from '../types.js'
import type { Launcher } from './command.js'
import { surfaceFor } from './index.js'
import { SurfaceRefused, type SurfaceOptions } from './options.js'
import { tmuxWindowPresent } from './tmux.js'

/**
 * A fake `tmux` first on PATH, so no test can reach the owner's real server. It
 * records each argv and keeps a session flag and a window list as files, with
 * switches for the failures a close has to survive.
 */
const FAKE_TMUX = `#!/bin/sh
d="$FAKE_TMUX_DIR"
for a in "$@"; do printf '%s\\0' "$a" >> "$d/calls"; done
printf '\\036' >> "$d/calls"
if [ "$1" = "-L" ]; then shift 2; fi
case "$1" in
  has-session) [ -f "$d/session" ] || { echo "can't find session" >&2; exit 1; } ;;
  new-window|new-session)
    touch "$d/session"; n=$(( $(cat "$d/next" 2>/dev/null || echo 7) )); echo $((n + 1)) > "$d/next"
    echo "@$n" >> "$d/windows"; echo "@$n" ;;
  kill-window)
    grep -qx -- "$3" "$d/windows" 2>/dev/null || { echo "can't find window: $3" >&2; exit 1; }
    [ -f "$d/stubborn" ] && exit 0
    grep -vx -- "$3" "$d/windows" > "$d/rest"; mv "$d/rest" "$d/windows"
    [ -s "$d/windows" ] || { rm -f "$d/session"; touch "$d/noserver"; } ;;
  list-windows)
    [ -f "$d/noserver" ] && { echo "no server running on /tmp/tmux-0/default" >&2; exit 1; }
    [ -f "$d/unreadable" ] && { echo "server wedged" >&2; exit 1; }
    [ -f "$d/denied" ] && { echo "error connecting to /tmp/tmux-0/default (Permission denied)" >&2; exit 1; }
    cat "$d/windows" 2>/dev/null ;;
esac
`

let dir = ''
const savedPath = process.env.PATH
const savedDir = process.env.FAKE_TMUX_DIR

const calls = (): string[][] =>
  fs
    .readFileSync(path.join(dir, 'calls'), 'utf8')
    .split('\x1e')
    .filter(call => call !== '')
    .map(call => call.split('\0').slice(0, -1))

const callsTo = (verb: string): string[][] => calls().filter(argv => argv.includes(verb))
const touch = (name: string): void => fs.writeFileSync(path.join(dir, name), '')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tmux-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'tmux'), FAKE_TMUX, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'calls'), '')
  touch('session')
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`
  process.env.FAKE_TMUX_DIR = dir
})

afterEach(() => {
  process.env.PATH = savedPath
  if (savedDir === undefined) delete process.env.FAKE_TMUX_DIR
  else process.env.FAKE_TMUX_DIR = savedDir
  fs.rmSync(dir, { recursive: true, force: true })
})

const LAUNCHER: Launcher = {
  argv: agentId => ['/usr/bin/node', '/opt/app/cli.js', 'run-agent', agentId],
  env: { LAUNCH_HOME: '/tmp/state' },
  relaunchPath: agentId => `/tmp/state/agents/${agentId}/relaunch`,
}

const plan = (over: Partial<LaunchPlan> = {}): LaunchPlan => ({
  agentId: 'ag000001',
  bin: 'claude',
  args: ['--model', 'sonnet'],
  cwd: '/tmp/work',
  env: {},
  title: 'scout',
  surface: 'tmux-window',
  ...over,
})

const tmuxFor = (options: SurfaceOptions = {}, launcher: Launcher = LAUNCHER) =>
  surfaceFor('tmux-window', launcher, options)

describe('tmux-window routing', () => {
  it('is its own interactive surface and never reaches AppleScript', async () => {
    const scripts: string[] = []
    const surface = tmuxFor({ platform: 'darwin', runAppleScript: async script => {
        scripts.push(script)
        return ''
      },
    })

    const handle = await surface.launch(plan())

    expect(surface.name).toBe('tmux-window')
    expect(surface.interactive).toBe(true)
    expect(handle.surface).toBe('tmux-window')
    expect(scripts).toEqual([])
    expect(callsTo('new-window')).toHaveLength(1)
  })
})

describe('an unknown surface name', () => {
  it('is refused rather than routed to AppleScript', () => {
    const scripts: string[] = []
    const runAppleScript = async (script: string): Promise<string> => {
      scripts.push(script)
      return ''
    }

    for (const name of ['bogus', 'tmux-pane']) {
      expect(() => surfaceFor(name as SurfaceName, LAUNCHER, { platform: 'darwin', runAppleScript })).toThrow(
        SurfaceRefused,
      )
    }
    expect(scripts).toEqual([])
  })
})

describe('launching into a tmux window', () => {
  it('opens a detached named window in fac running the fixed launcher line', async () => {
    const handle = await tmuxFor().launch(plan())

    expect(handle).toEqual({ surface: 'tmux-window', paneRef: '@7', ownsSurface: true })
    expect(callsTo('new-window')[0]).toEqual([
      'new-window', '-d', '-P', '-F', '#{window_id}', '-n', 'scout', '-t', '=fac:',
      "LAUNCH_HOME='/tmp/state' '/usr/bin/node' '/opt/app/cli.js' 'run-agent' 'ag000001'",
    ])
  })

  it('never puts the plan bin, args or brief on the command line', async () => {
    await tmuxFor().launch(plan({ bin: 'claude-secret-bin', args: ['go and audit the parser'] }))

    expect(calls().flat().join(' ')).not.toMatch(/claude-secret-bin|audit the parser/)
  })

  it('takes the session and the socket from options', async () => {
    await tmuxFor({ tmuxSession: 'seats', tmuxSocket: 'scratch' }).launch(plan())

    const [argv = []] = callsTo('new-window')
    expect(argv.slice(0, 2)).toEqual(['-L', 'scratch'])
    expect(argv).toContain('=seats:')
    expect(callsTo('has-session')[0]).toEqual(['-L', 'scratch', 'has-session', '-t', '=seats'])
  })

  it('starts the session, with a notice, when it does not exist', async () => {
    fs.rmSync(path.join(dir, 'session'))
    const notices: string[] = []

    const handle = await tmuxFor({ onNotice: message => void notices.push(message) }).launch(plan())

    expect(handle.paneRef).toBe('@7')
    expect(callsTo('new-window')).toEqual([])
    expect(callsTo('new-session')[0]?.slice(0, 9)).toEqual([
      'new-session', '-d', '-P', '-F', '#{window_id}', '-n', 'scout', '-s', 'fac',
    ])
    expect(notices).toEqual(["tmux session 'fac' did not exist; starting it"])
  })

  it('keeps a # in a new session name literal', async () => {
    fs.rmSync(path.join(dir, 'session'))

    await tmuxFor({ tmuxSession: 'a#(touch pwned)' }).launch(plan())

    const argv = callsTo('new-session')[0] ?? []
    expect(argv[argv.indexOf('-s') + 1]).toBe('a##(touch pwned)')
  })

  it('names the window for the agent id when the plan has no title', async () => {
    await tmuxFor().launch(plan({ title: '' }))

    expect(callsTo('new-window')[0]).toContain('ag000001')
  })

  it('keeps hostile names and argv words literal for tmux and its shell', async () => {
    const out = path.join(dir, 'out dir')
    fs.mkdirSync(out)
    const words = ['a b', `it's`, 'x"; touch pwned; "', '$(touch pwned)', '`touch pwned`', 'two\nlines', '#(touch pwned)']
    const launcher: Launcher = {
      argv: () => ['/bin/sh', '-c', 'printf "%s\\n" "$@" > "$OUT/argv"', 'sh', ...words],
      env: { OUT: out },
      relaunchPath: () => '/unused',
    }
    const title = `it's "x"; \`touch pwned\` #(touch pwned)`

    await tmuxFor({}, launcher).launch(plan({ agentId: 'a b; c', title }))

    const argv = callsTo('new-window')[0] ?? []
    expect(argv[argv.indexOf('-n') + 1]).toBe(`it's "x"; \`touch pwned\` ##(touch pwned)`)
    const ran = spawnSync('/bin/sh', ['-c', argv.at(-1) ?? ''], { cwd: dir })
    expect(ran.status).toBe(0)
    expect(fs.readFileSync(path.join(out, 'argv'), 'utf8')).toBe(`${words.join('\n')}\n`)
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false)
  })

  it('refuses, naming headless, when tmux is not installed', async () => {
    process.env.PATH = path.join(dir, 'empty')

    await expect(tmuxFor().launch(plan())).rejects.toThrow(SurfaceRefused)
    await expect(tmuxFor().launch(plan())).rejects.toThrow("use surface 'headless'")
  })
})

describe('closing a tmux window', () => {
  it('kills the window it opened by id, then goes back and looks', async () => {
    const surface = tmuxFor()
    const handle = await surface.launch(plan())
    await surface.launch(plan({ agentId: 'ag000002' }))

    await expect(surface.close(handle)).resolves.toEqual({ closed: true })
    expect(callsTo('kill-window')).toEqual([['kill-window', '-t', '@7']])
    expect(calls().at(-1)).toEqual(['list-windows', '-a', '-F', '#{window_id}'])
  })

  it('reads a server that went with its last window as closed', async () => {
    const surface = tmuxFor()
    const handle = await surface.launch(plan())

    await expect(surface.close(handle)).resolves.toEqual({ closed: true })
    expect(fs.existsSync(path.join(dir, 'noserver'))).toBe(true)
  })

  it('does not touch a window it did not open', async () => {
    const outcome = await tmuxFor().close({ surface: 'tmux-window', paneRef: '@3' })

    expect(outcome).toEqual({ closed: false, reason: 'the host did not open this surface, so it is not ours to close' })
    expect(calls()).toEqual([])
  })

  it('reports closed:false when the window survives the kill', async () => {
    const surface = tmuxFor()
    const handle = await surface.launch(plan())
    touch('stubborn')

    await expect(surface.close(handle)).resolves.toEqual({
      closed: false,
      reason: 'tmux still lists window @7 after killing it',
    })
  })

  it('does not report a close it could not confirm', async () => {
    const surface = tmuxFor()
    const handle = await surface.launch(plan())
    await surface.launch(plan({ agentId: 'ag000002' }))
    touch('unreadable')

    await expect(surface.close(handle)).resolves.toEqual({
      closed: false,
      reason: 'could not re-read tmux to confirm window @7 is gone',
    })
  })

  it('does not read a socket it may not open as a server that is gone', async () => {
    const surface = tmuxFor()
    const handle = await surface.launch(plan())
    await surface.launch(plan({ agentId: 'ag000002' }))
    touch('denied')

    await expect(surface.close(handle)).resolves.toEqual({
      closed: false,
      reason: 'could not re-read tmux to confirm window @7 is gone',
    })
  })

  it('says why when the window was already gone', async () => {
    const outcome = await tmuxFor().close({ surface: 'tmux-window', paneRef: '@9', ownsSurface: true })

    expect(outcome).toEqual({ closed: false, reason: 'tmux could not kill window @9: can\'t find window: @9' })
  })
})

describe('a tmux window across an agent exit and a resume', () => {
  it('reports present, then gone once the window exits with its agent', async () => {
    await tmuxFor().launch(plan())
    await tmuxFor().launch(plan({ agentId: 'ag000002' }))
    expect(await tmuxWindowPresent('@7')).toBe(true)

    fs.writeFileSync(path.join(dir, 'windows'), '@8\n')

    expect(await tmuxWindowPresent('@7')).toBe(false)
  })

  it('says unknown, never gone, when tmux cannot be read', async () => {
    touch('unreadable')

    expect(await tmuxWindowPresent('@7')).toBeUndefined()
  })

  it('reopens a window on resume rather than reusing the closed one', async () => {
    const surface = tmuxFor()
    const first = await surface.launch(plan())
    await surface.close(first)

    const resumed = await surface.launch(plan())

    expect(resumed).toEqual({ surface: 'tmux-window', paneRef: '@8', ownsSurface: true })
    expect(callsTo('new-session')).toHaveLength(1)
  })
})
