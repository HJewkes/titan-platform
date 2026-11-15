# service-supervisor

**Tier 1.** Depends on [`daemon`](/reference/daemon) for its escaping helpers.

```sh
npm install @titan-design/service-supervisor
```

## The problem it solves

A long-running job that should survive a crash and a reboot needs a systemd user unit on
Linux and a LaunchAgent plist on macOS. Each format has its own escaping traps, and the
two were written by hand inside one product. This package renders both from one
`ServiceSpec`.

## When to reach for it

You have a job (argv, environment, log files) and need the file text for either
supervisor. For the escaping helpers alone, or to build the job's PATH, use
[`daemon`](/reference/daemon)'s `service` export.

## Example

```ts
import { renderLaunchAgentPlist, renderSystemdUserService } from "@titan-design/service-supervisor";

const spec = {
  label: "example.worker",
  description: "Example worker",
  argv: ["/usr/bin/node", "/opt/app/cli.js", "serve"],
  environment: { NODE_ENV: "production" },
  stdoutPath: "/var/log/app/out.log",
  stderrPath: "/var/log/app/err.log",
  restart: "always",
  launchdProcessType: "Interactive",
};

renderSystemdUserService(spec); // "[Unit]\nDescription=Example worker\n..."
renderLaunchAgentPlist(spec); // '<?xml version="1.0" ...'
```

## What it deliberately does not do

It writes no file and runs neither `systemctl` nor `launchctl`. It does not pick a PATH, a
log directory or a unit file name; the caller owns those.

## Gotchas

- `label` is the launchd Label. systemd names a unit by its file name, so the unit
  renderer ignores it.
- systemd expands `%` in every value and `$` in `ExecStart`, so both are doubled for you;
  launchd expands neither, so the plist keeps them literal.
- The unit renderer throws on a line break in the description, an argv entry, a log path or
  an environment value, because a unit file is line-oriented.
- `restart: "on-failure"` becomes `KeepAlive` with `SuccessfulExit` false in the plist.
- Every environment entry is written as `Environment="KEY=value"`.

## Where it came from

Extracted from active-work's `supervision-systemd.ts` and `supervision-launchd.ts`, which
now call it.
