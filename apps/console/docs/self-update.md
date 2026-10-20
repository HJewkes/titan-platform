# Self-update

The served console rebuilds and restarts itself within about 15 minutes of a console change
landing on main (TP-2258). A systemd user timer runs `titan-console self-update` every 10
minutes; the updater is the only thing that changes what the service runs.

## Layout

Everything lives under `~/.local/share/titan-console` (`TITAN_CONSOLE_UPDATE_ROOT`):

| Path | What it is |
| --- | --- |
| `checkout/` | The clone the updater fetches in. It is never built into again once `current` leaves it |
| `releases/<sha>/` | One `git worktree` of `checkout/` per build, installed and built in place |
| `current` | Symlink to the release being served. `titan-console.service` and the timer's service both start `current/apps/console/dist/cli.js` |

The updater keeps the serving release and the one before it, and removes older ones with
`git worktree remove`. It never removes `checkout/`.

## One pass

1. Takes `$TITAN_CONSOLE_STATE/self-update.lock`. A second run while one holds it exits 75 and
   changes nothing. A lock whose pid is gone is taken over.
2. `git fetch origin main` in `checkout/`. When the served tree's `HEAD` is origin/main, it stops.
3. When the last attempt at this same sha failed (`self-update.json`), it stops: a broken sha is
   not rebuilt every 10 minutes. The next main commit is tried as usual.
4. Lists the console's workspace closure with `pnpm --filter "titan-console..." ls --json` in the
   served tree, and diffs the served sha against origin/main. A change counts when it is a root
   build input (`pnpm-lock.yaml`, `package.json`, `pnpm-workspace.yaml`, `.npmrc`, a root
   `tsconfig*.json`) or a file in a closure package other than a test or a `.md`. With none, it
   stops and the old build keeps serving.
5. `git worktree add --detach releases/<sha>`, `pnpm install --frozen-lockfile`, then
   `pnpm --filter "titan-console..." build`. A failure writes the output to
   `$TITAN_CONSOLE_STATE/self-update-build.log` and removes the release.
6. Smoke check: starts the new bin on a spare loopback port with a scratch state dir and no
   `TITAN_CONSOLE_*` settings, so it binds no LAN listener and shares no pid file. It must answer
   `/health` with `build.sha` equal to the new sha within 60 s, and serve its page at `/`.
7. Swaps `current` to the new release by renaming a fresh symlink over it.
8. `systemctl --user restart titan-console.service`, then polls `/health` on
   `TITAN_CONSOLE_PORT` until it reports the new sha, for up to 60 s. When it does not, `current`
   goes back to the old release and the unit is restarted once more.

Every failure records `self-update.json` (`outcome`, `stage`, `target`, `served`, `why`) and files an
owner-queue item through `@titan-design/owner-queue`'s `writeDeposit` into the console's inbox
spool (`TITAN_CONSOLE_INBOX_DIR`), the same path the factory's deploy incident uses. The item is
keyed `console-update-<sha>-<stage>`, so one broken sha files one item. A rollback that does not
answer `/health` either is filed as "CONSOLE MAY BE DOWN".

`/health` carries the served build as `build: { sha, builtAt, dirty }`, read from
`dist/build-info.json`, which `build` writes last. The footer shows the same through
`console.build`.

## Owner step: install

Installing units is an owner step. Run these once, after this change is on main:

```sh
# 1. Build the current main in the existing checkout by hand once, so `self-update` exists there.
cd ~/.local/share/titan-console/checkout
git fetch -q origin main && git checkout -q --detach origin/main
pnpm install --frozen-lockfile && pnpm --filter "titan-console..." build

# 2. Point `current` at it and install the units from the repo.
ln -sfn ~/.local/share/titan-console/checkout ~/.local/share/titan-console/current
cp apps/console/deploy/systemd/titan-console.service.d/20-current.conf ~/.config/systemd/user/titan-console.service.d/
cp apps/console/deploy/systemd/titan-console-update.service apps/console/deploy/systemd/titan-console-update.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user restart titan-console.service
curl -s http://127.0.0.1:7500/health | grep -o '"sha":"[0-9a-f]*"'   # the sha from step 1

# 3. Start the timer and run one pass by hand.
systemctl --user enable --now titan-console-update.timer
systemctl --user start titan-console-update.service; journalctl --user -u titan-console-update.service -n 30
```

The console's port and state dir come from the same `TITAN_CONSOLE_PORT` and
`TITAN_CONSOLE_STATE` defaults as the service. If the service sets either in a drop-in, set the
same in a `titan-console-update.service.d/` drop-in.

## Operating it

| Want | Command |
| --- | --- |
| See the last pass | `journalctl --user -u titan-console-update.service -n 50` and `cat ~/.local/state/titan-console/self-update.json` |
| Retry a held sha | `rm ~/.local/state/titan-console/self-update.json`, then `systemctl --user start titan-console-update.service` |
| Pause updates | `systemctl --user stop titan-console-update.timer` |
| Roll back by hand | `ln -sfn ~/.local/share/titan-console/releases/<older sha> ~/.local/share/titan-console/current && systemctl --user restart titan-console.service` |
| Remove it | `systemctl --user disable --now titan-console-update.timer`, delete the two unit files and `20-current.conf`, `daemon-reload`, restart the service |
