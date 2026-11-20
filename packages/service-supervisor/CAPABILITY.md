# service-supervisor: use this when

You need the text of a systemd user unit or a launchd LaunchAgent plist for a long-running job (argv, environment, log files, restart policy). It renders and escapes; it never writes a file or runs `systemctl` or `launchctl`, so installing and starting the job stays with the caller. For the escaping helpers alone, or a PATH for the job, use `daemon/service`.
