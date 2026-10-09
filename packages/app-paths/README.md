# @titan-design/app-paths

Resolve an app's per-user data, config, cache and log directories the way
[env-paths](https://github.com/sindresorhus/env-paths) does with `{ suffix: "" }`, plus
active-work's data root with its `ACTIVE_ROOT` override. No runtime dependencies.

```ts
import { activeWorkGraphPath, activeWorkRoot, appDirs } from "@titan-design/app-paths";

activeWorkRoot(); // ACTIVE_ROOT if non-empty, else the platform data directory
activeWorkGraphPath(); // <root>/.miner/graph.sqlite3
appDirs("my-app", { platform: "linux", home: "/home/me", env: {} }).data; // /home/me/.local/share/my-app
```

Every function takes an optional `{ env, home, platform }`, defaulting to `process.env`,
`os.homedir()` and `process.platform`.

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.
