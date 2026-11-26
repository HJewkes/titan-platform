# Idle heartbeat: wake a seat on its own idle time

A coordinator seat that arms a fixed `CronCreate` heartbeat (say every 20 minutes) is woken
on the clock, not on need. A tick that lands a minute after the seat finished a turn re-reads
its whole context for nothing, and a seat that is busy turn after turn is ticked anyway.

`titan heartbeat idle` wakes a session only after it has gone a set time without a turn. It
reads the session's own transcript: the idle clock starts when the newest main-chain turn
ends, every turn restarts it, and a session mid-turn (a tool running, a prompt queued) is
never woken.

## How it works

The command polls the transcript tail (every 30 s by default). When the session has been
idle for `--idle`, it prints one wake line and exits. The seat runs it with Bash
`run_in_background`, so the exit is what wakes the seat: Claude Code delivers a finished
background task's output as a new turn. That turn ends, the idle clock restarts, and the seat
re-arms the beat. The wake line carries the exact re-arm command.

| Option | Meaning |
| --- | --- |
| `--idle <duration>` | Idle time since the last turn that fires the beat: `90s`, `20m`, `1h`; a bare number is minutes. Required. |
| `--prompt <text>` | What the wake line asks the seat to do. Required. |
| `--max <duration>` | Optional ceiling: once this long has passed since arming, fire at the next moment the session is between turns, even if it never idled for `--idle`. Must be longer than `--idle`. |
| `--stop-cmd <command>` | Optional shell command, run only when a beat is due. Exit 0 means the stop condition holds: the command prints a stop line instead of the beat, and the seat should not re-arm until there is work to watch again. |
| `--session <id>` | The session to watch. Defaults to `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for every command a session runs. |
| `--poll <duration>` | How often to read the transcript. Default `30s`. |

The run ends quietly with no output when the session that armed it exits (`CLAUDE_PID` is
gone), so a parked seat leaves nothing polling.

## Replacing a CronCreate heartbeat

1. Build titan once: `pnpm build`, then the bin is `products/titan/dist/bin.js`.
2. Delete the seat's `CronCreate` heartbeat job.
3. In the seat's boot steps, arm the beat with Bash `run_in_background: true`:

   ```sh
   node <titan checkout>/products/titan/dist/bin.js heartbeat idle \
     --idle 20m --max 60m \
     --prompt "Heartbeat: run your tick per the charter" \
     --stop-cmd ./seat-quiet.sh
   ```

4. In the tick instructions, add one step: when the tick is done, run the re-arm command the
   wake line printed, again in the background.

`seat-quiet.sh` is the seat's own stop condition, for example "no live workers and an empty
queue": a script that reads the seat's roster and queue and exits 0 only when both are empty.
It runs once per due beat, not once per poll, so a slow roster read costs little.

## Why a background command and not a Monitor

A `Monitor` is killed at its timeout, at most 30 minutes, and its expiry notice is itself a
wake. A Monitor-hosted beat would wake the seat every 30 minutes whether or not it was idle,
which is the fixed schedule this replaces. A background Bash command has no such deadline and
wakes the seat exactly once, when it exits.

## Compaction and teleport

- **Compaction.** The beat runs outside the seat's context, so a `/compact` or an automatic
  compaction does not touch it, and it keeps no state file. The records a compaction or a
  local slash command writes (the compact summary, `<local-command-stdout>`) get no reply,
  so the reader skips them and the idle clock keeps running from the last real turn. The re-arm command arrives in the
  wake line itself, so a compacted seat does not need to remember it.
- **Teleport.** The successor is a new session with a new `CLAUDE_CODE_SESSION_ID`; the old
  beat ends when the old session exits. Arm the beat in the boot steps, as above, and the
  successor picks up its own session id. Pass `--session` only when watching a session other
  than the one running the command, because a named session is carried into the re-arm line.
