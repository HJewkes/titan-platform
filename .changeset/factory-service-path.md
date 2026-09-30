---
"@titan-design/factory": patch
---

The LaunchAgent plist now sets `EnvironmentVariables` with one variable, `PATH`: the directories of `gh`, `agent-chat` and `claude` as found at install time, node's directory, then launchd's four. Under launchd's default `PATH` serve could not run `gh`. A directory with a `:` in its name is refused, `--node` included. A binary that is not found gets a warning line, and `service install` refuses to run without `gh`. `service install`, `restart` and `status` exit non-zero when `/health` answers but its `github` field is not `ok`, and no longer accept a `/health` with no pid for a job launchd reports no pid for.
