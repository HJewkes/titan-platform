# Self-update

The served console rebuilds and restarts itself within about 15 minutes of a console change
landing on main (TP-2258). A systemd user timer starts `titan-console-update.service` every 10
minutes, and that unit runs a small fixed bootstrap. The bootstrap builds origin/main into a new
release and hands off to **that release's own updater** (TP-4043). A fix to the updater therefore
applies on the pass that builds it: no installed build ever judges the build that replaces it.

## Layout

Everything lives under `~/.local/share/titan-console` (`TITAN_CONSOLE_UPDATE_ROOT`):

| Path | What it is |
| --- | --- |
| `bin/titan-console-bootstrap.mts` | A copy of `apps/console/deploy/titan-console-bootstrap.mts`, made once by the owner if they take the optional step below. It sits outside every release, so no release can break it |
| `checkout/` | The clone the bootstrap fetches in. It is never built into again once `current` leaves it |
| `releases/<sha>/` | One `git worktree` of `checkout/` per build, installed and built in place |
| `current` | Symlink to the release being served. `titan-console.service` starts `current/apps/console/dist/cli.js` |

One file lives outside the root: `~/.local/bin/titan-console` (`TITAN_CONSOLE_BIN_DIR`), the shim
that puts the CLI on `PATH`, so a seat runs `titan-console inbox file -` without locating `cli.js`.

The updater keeps the serving release and the one before it, and removes older ones with
`git worktree remove`, only after the new release answers `/health`. It never removes `checkout/`.

## One pass

The bootstrap only locks, fetches, builds and hands off. Node 24 runs it as is (type stripping),
and it imports nothing but node builtins.

1. Takes `$TITAN_CONSOLE_STATE/self-update-bootstrap.lock`. A second run while one holds it exits 75
   and changes nothing. A lock whose pid is gone is taken over.
2. `git fetch origin main` in `checkout/`. When the served tree's `HEAD` is origin/main, it stops.
3. When `self-update.json` already names origin/main's sha as its `target`, it stops: that sha was
   judged (updated, unchanged, failed or rolled back), and a broken sha is not rebuilt every 10
   minutes. The next main commit is tried as usual.
4. Unless `releases/<sha>/apps/console/dist/build-info.json` exists from an earlier pass:
   `git worktree add --detach releases/<sha>`, `pnpm install --frozen-lockfile`, then
   `pnpm --filter "titan-console..." build`. A failure writes the output to
   `$TITAN_CONSOLE_STATE/self-update-build.log`, removes the release, records the failure and
   asks the serving build to file the alarm (`self-update --report`).
5. Runs `node releases/<sha>/apps/console/dist/cli.js self-update --apply <sha>`, with its output in
   the unit's journal. When that exits non-zero without recording an outcome for `<sha>`, the
   bootstrap records a `handoff` failure and asks for the alarm the same way.

The new release's updater (`self-update --apply <sha>`) then:

1. Takes `$TITAN_CONSOLE_STATE/self-update.lock`, the same way.
2. Lists the console's workspace closure with `pnpm --filter "titan-console..." ls --json` in the
   new release, and diffs the served sha against `<sha>`. A change counts when it is a root build
   input (`pnpm-lock.yaml`, `package.json`, `pnpm-workspace.yaml`, `.npmrc`, a root
   `tsconfig*.json`) or a file in a closure package other than a test or a `.md`. With none, it
   records `unchanged`, removes the release, and the old build keeps serving.
3. Smoke check: starts the new bin on a spare loopback port with a scratch state dir and no
   `TITAN_CONSOLE_*` settings, so it binds no LAN listener and shares no pid file. It must answer
   `/health` with `build.sha` equal to the new sha within 60 s, and serve its page at `/`. When
   the bin exits first, the check stops at once, and the reason ends with the last 20 lines of its
   stderr (at most 1000 characters), which also reach the owner-queue item. It runs as
   `self-update --smoke <release> <sha>` in a child that is stopped with SIGTERM after 2 minutes
   (SIGKILL 10 s later).
4. Swaps `current` to the new release by renaming a fresh symlink over it.
5. `systemctl --user restart titan-console.service`, then polls `/health` on
   `TITAN_CONSOLE_PORT` until it reports the new sha, for up to 60 s. When it does not, `current`
   goes back to the previous release, which is still on disk, and the unit is restarted once more.
6. Only after the new sha answers does it record `updated` and prune releases older than the
   previous one.
7. Writes the `titan-console` shim into `TITAN_CONSOLE_BIN_DIR` (default `~/.local/bin`): a `sh`
   script that runs `exec node <root>/current/apps/console/dist/cli.js "$@"`, mode 755. It names
   `current/`, never a release dir, so a later rollback leaves it valid. A shim that already holds
   that text is not rewritten; a new one is written to a temp file and renamed over the old. A
   failed write is logged in the unit's journal and does not undo the update, record a failure or
   file an alarm. Nothing else writes the shim, so the first update after this change creates it.

Every failure records `self-update.json` (`outcome`, `stage`, `target`, `served`, `why`) and files an
owner-queue item through `@titan-design/owner-queue`'s `writeDeposit` into the console's inbox
spool (`TITAN_CONSOLE_INBOX_DIR`), the same path the factory's deploy incident uses; console-coord
reads it there. The item is keyed `console-update-<sha>-<stage>`, so one broken sha files one item.
Stages are `build` and `handoff` (from the bootstrap) and `smoke`, `restart` and `rollback` (from
the updater). A rollback that does not answer `/health` either is filed as "CONSOLE MAY BE DOWN".
A held sha files nothing more: its item was filed when it failed.

`/health` carries the served build as `build: { sha, builtAt, dirty }`, read from
`dist/build-info.json`, which `build` writes last. The footer shows the same through
`console.build`.

## Without an owner step

A timer unit installed before TP-4043 runs `current/apps/console/dist/cli.js self-update` with no
flags. That bare verb still works: it runs `node current/apps/console/deploy/titan-console-bootstrap.mts`,
the serving release's own copy of the bootstrap, with the same `TITAN_CONSOLE_UPDATE_ROOT` and
`TITAN_CONSOLE_STATE`, and exits with its code. The old updater deploys this change, and from the
next timer run on the old unit updates through the bootstrap. Nothing needs installing.

## Optional owner step: pin the bootstrap

Optional hardening. With the old unit, the bootstrap comes from the serving release, so a release
that breaks its own bootstrap file stops further updates until a fixed one is swapped in by hand.
Installing the bootstrap outside every release removes that case. Run it once, as the user that runs
`titan-console.service`, on `<host>.<tailnet>.ts.net`; nothing else installs or enables a unit:

```sh
ssh <host>.<tailnet>.ts.net
cd ~/.local/share/titan-console/checkout
git fetch -q origin main

# 1. Only if `current` is not a symlink yet (an install from before TP-2258):
#    point it at the checkout and run the service from it.
ln -sfn ~/.local/share/titan-console/checkout ~/.local/share/titan-console/current
mkdir -p ~/.config/systemd/user/titan-console.service.d
git show origin/main:apps/console/deploy/systemd/titan-console.service.d/20-current.conf > ~/.config/systemd/user/titan-console.service.d/20-current.conf

# 2. Copy the bootstrap outside every release, and install the units that run it.
mkdir -p ~/.local/share/titan-console/bin
git show origin/main:apps/console/deploy/titan-console-bootstrap.mts > ~/.local/share/titan-console/bin/titan-console-bootstrap.mts
git show origin/main:apps/console/deploy/systemd/titan-console-update.service > ~/.config/systemd/user/titan-console-update.service
git show origin/main:apps/console/deploy/systemd/titan-console-update.timer > ~/.config/systemd/user/titan-console-update.timer
systemctl --user daemon-reload

# 3. Clear a hold the old in-app updater may have left on the sha it was stuck on, then run one pass.
rm -f ~/.local/state/titan-console/self-update.json
systemctl --user start titan-console-update.service
journalctl --user -u titan-console-update.service -n 50
curl -s http://127.0.0.1:7500/health | grep -o '"sha":"[0-9a-f]*"'   # origin/main's sha, when a console change landed

# 4. Keep the timer on.
systemctl --user enable --now titan-console-update.timer
```

`node` on the unit's `PATH` must be 24 or later (the repo's `.node-version`), for type stripping.
The console's port and state dir come from the same `TITAN_CONSOLE_PORT` and
`TITAN_CONSOLE_STATE` defaults as the service. If the service sets either in a drop-in, set the
same in a `titan-console-update.service.d/` drop-in.

A change to the updater never needs an owner step. With the bootstrap pinned, a change to the
bootstrap itself does: repeat step 2's `git show … > bin/titan-console-bootstrap.mts` line.

## Operating it

| Want | Command |
| --- | --- |
| See the last pass | `journalctl --user -u titan-console-update.service -n 50` and `cat ~/.local/state/titan-console/self-update.json` |
| Retry a held sha | `rm ~/.local/state/titan-console/self-update.json`, then `systemctl --user start titan-console-update.service` |
| Pause updates | `systemctl --user stop titan-console-update.timer` |
| Roll back by hand | `ln -sfn ~/.local/share/titan-console/releases/<older sha> ~/.local/share/titan-console/current && systemctl --user restart titan-console.service` |
| Remove it | `systemctl --user disable --now titan-console-update.timer`, delete the two unit files, `bin/` and `20-current.conf`, `daemon-reload`, restart the service |
