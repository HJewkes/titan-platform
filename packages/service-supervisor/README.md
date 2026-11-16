# @titan-design/service-supervisor

Render systemd user units and launchd plists for a long-running job.

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

See the [reference page](../../site/reference/service-supervisor.md) for the API and gotchas.
