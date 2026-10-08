# app-paths

**Tier 0.** No titan dependencies, and no runtime dependencies at all.

```sh
npm install @titan-design/app-paths
```

## The problem it solves

active-work keeps its initiatives and its session graph under a per-user data directory that
it resolves with env-paths and an `ACTIVE_ROOT` override. Other products that read that data
re-derived the location by hand, and each copy drifted: some hard-coded the macOS path, some
ignored `ACTIVE_ROOT`, some ignored `XDG_DATA_HOME` on Linux. This package is the one rule:
`appDirs` reproduces env-paths' data, config, cache and log table, and `appDataRoot` adds an
override variable on top. `activeWorkRoot` and `activeWorkGraphPath` are that rule with
active-work's name and variable filled in.

## When to reach for it

- A product needs active-work's data root or its `.miner/graph.sqlite3` path as a default, and
  must agree with what the `active-work` CLI itself would use.
- Any app needs its own per-user data, config, cache or log directory and wants a pure,
  testable function instead of env-paths' read of the live process.

Not for expanding `~` in arbitrary paths (`expandHome` in session-read), and not for spotting
data-directory paths in outgoing text (egress-scan).

## Example

Verified against 0.0.0.

```ts
import { ACTIVE_WORK, activeWorkGraphPath, activeWorkRoot, appDataRoot, appDirs } from "@titan-design/app-paths";

activeWorkRoot();
// ACTIVE_ROOT when non-empty, else appDirs("active-work").data:
// darwin under Library's Application Support, linux under XDG_DATA_HOME
// (default .local/share), win32 under LOCALAPPDATA with a Data leaf

activeWorkGraphPath({ env: { ACTIVE_ROOT: "~/aw" }, home: "/home/me", platform: "linux" });
// /home/me/aw/.miner/graph.sqlite3

appDataRoot({ name: "my-app", overrideVar: "MY_APP_ROOT" });
appDirs("my-app"); // { data, config, cache, log }
appDataRoot(ACTIVE_WORK); // same as activeWorkRoot()
```

Every function takes an optional `{ env, home, platform }`. Each field defaults to
`process.env`, `os.homedir()` and `process.platform`, so tests pass all three and production
code passes none.

## What it deliberately does not do

- It creates no directories and checks no existence; it only computes paths.
- It knows nothing about active-work's initiatives, tasks or files below the root, other than
  the session graph path that several products default to.
- It does not return env-paths' `temp` directory.

## Gotchas

- On macOS the XDG variables are ignored, exactly as env-paths ignores them. Setting
  `XDG_DATA_HOME` on a Mac does not move the data root; set the override variable instead.
- An empty override variable or empty XDG variable counts as unset.
- The override expands only `~` and `~/...`, not `~user`, and a relative override resolves
  against the current working directory.
- Paths are joined with the host's `node:path`, so a `win32` result computed on macOS uses
  forward slashes. Injecting `platform` picks the table, not the separator.

## Where it came from

Extracted from active-work's `getActiveRoot` (env-paths with `{ suffix: "" }` plus
`ACTIVE_ROOT`), which it matches. It replaces the hand-written copies in the console server
and retrieval-eval. A test pins `appDirs` to env-paths on the host platform.
