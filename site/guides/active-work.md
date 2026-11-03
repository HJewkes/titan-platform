# active-work

`products/active-work` is the durable workspace state for engineering work: initiatives, tasks,
notes, sources, open loops and sessions, kept as plain files under one active root. The
package is `@titan-design/active-work`. It ships two bins, `active-work` and `aw`, and the
Claude Code skill and `/aw-prompt` command that go with them. The
[reference page](/reference/active-work) lists its exports.

## The three surfaces

| Surface | Entry | What it is for |
| --- | --- | --- |
| CLI | `active-work <command>`, `aw <initiative>` | Create and edit initiatives and tasks; `aw` launches a Claude session seeded with the bootstrap prompt. |
| MCP | `active-work mcp serve` | The same verbs as MCP tools, over a loopback HTTP daemon. |
| Daemon | the supervisor unit running `mcp serve` | Keeps the registry, session index and miner warm; answers `/health`. |

Data lives under `$ACTIVE_ROOT`, which defaults to `$XDG_DATA_HOME/active-work`. Runtime
state (pid file, logs) lives under `$XDG_STATE_HOME/active-work`.

## Develop it in the monorepo

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm vitest run products/active-work
```

A workspace install does not touch `~/.claude`: the package's postinstall and preuninstall
scripts exit unless the package sits under a `node_modules` path.

## The tarball smoke test

`scripts/active-work-pack.test.mjs` packs the product and every workspace package it depends
on, installs the tarballs into a scratch prefix with a scratch `HOME`, and runs the installed
bins:

1. `active-work --version` equals the version in `package.json`.
2. `aw --help` exits 0.
3. The tarball lists `dist/cli.js`, `dist/aw.js`, `skill/SKILL.md`,
   `claude-commands/aw-prompt.md`, `scripts/postinstall.js` and `docs/cli-reference.md`.
4. Postinstall copied the skill and command into the scratch `.claude`.
5. `active-work new`, `task add`, `task list` and `prompt` work against a synthetic root.

Removing `skill` from `files`, or neutering the `prepack` step that generates
`docs/cli-reference.md`, turns it red. The same install shape is what the cutover below uses,
so a green run means the artifact installs; it does not check your live data.

## Cutover to a tarball from main

The owner runs this on each host that runs active-work. Nothing here needs a published
release: it installs a closure tarball packed from `main`. Install into a versioned prefix
and re-point the bin links, so rollback is one command.

Placeholders: `<id>` is the short sha of the `main` commit you pack, `<host>.<tailnet>.ts.net`
is a remote host you check from another machine.

### 1. Back up the data

The daemon migrates the session graph in place on first start, and downgrading is not
verified. Rolling back past the first start therefore means restoring this copy.

```sh
systemctl --user stop active-work
cp -a "$ACTIVE_ROOT" "$ACTIVE_ROOT.backup-<id>"
```

`$ACTIVE_ROOT` includes the hidden state directories (the session graph and the workspace
index). Check that the copy holds them:

```sh
ls -a "$ACTIVE_ROOT.backup-<id>"
```

### 2. Pack and install

From a clean worktree of `main` at `<id>`:

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p "$HOME/.local/opt/active-work/<id>/tarballs"
pnpm --filter "@titan-design/active-work..." exec pnpm pack \
  --pack-destination "$HOME/.local/opt/active-work/<id>/tarballs"
npm install --prefix "$HOME/.local/opt/active-work/<id>" --no-audit --no-fund \
  "$HOME"/.local/opt/active-work/<id>/tarballs/*.tgz
```

The filter packs the product and its workspace closure, so versions not yet on npm are
covered. Install all the tarballs in one `npm install` so they share one `node_modules`; a
global install leaves the sibling packages' third-party dependencies out. The prefix sits
outside the active root so the root never sees it. Postinstall refreshes the skill under
`~/.claude`, which is intended.

### 3. Re-point the bins

```sh
BIN="$HOME/.local/opt/active-work/<id>/node_modules/.bin"
ln -sfn "$BIN/active-work" "$HOME/.local/bin/active-work"
ln -sfn "$BIN/aw" "$HOME/.local/bin/aw"
systemctl --user start active-work
```

The link names do not change, so the unit, relay's `ACTIVE_WORK_BIN_PATH` and every caller of
`active-work` need no edit. On macOS, restart the launchd job instead of the systemd unit.

### 4. Verify

```sh
active-work --version
active-work mcp status
active-work list
```

`mcp status` must show the new version and a port; `curl -s http://127.0.0.1:<port>/health`
must answer OK. Then open one real initiative with `aw <initiative>`, make the relay call that
uses `ACTIVE_WORK_BIN_PATH`, and read one source through the MCP tool `active__source__read`.
For a remote host, repeat the version and status checks over `ssh <host>.<tailnet>.ts.net`.

### 5. Roll back

Within the first day, before newer task files accumulate:

```sh
systemctl --user stop active-work
ln -sfn "<previous>/active-work" "$HOME/.local/bin/active-work"
ln -sfn "<previous>/aw" "$HOME/.local/bin/aw"
```

`<previous>` is the directory of the build you replaced (a checkout's `dist/cli.js` and
`dist/aw.js`, or an earlier prefix's `node_modules/.bin`). If the daemon already started on
the new build, also restore the data copy before starting the old one:

```sh
rm -rf "$ACTIVE_ROOT"
cp -a "$ACTIVE_ROOT.backup-<id>" "$ACTIVE_ROOT"
systemctl --user start active-work
```

Later, roll forward instead: task files written by the new build can carry fields the old
build rejects.

## Moving to the npm release

When `@titan-design/active-work` is published from this repo, install it the same way into a
new prefix (`npm install --prefix <new> @titan-design/active-work@<version>`), re-point the
two links and restart. The code is the same, so only the packaging changes; keep the previous
prefix for rollback.
