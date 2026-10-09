# Serving the console on the LAN

This is the install runbook for `titan-console.service`, a systemd user unit that runs the
console on loopback and, behind authentication, on one LAN address. The code is in
[the README's LAN mode section](../README.md#lan-mode). **Nothing here is installed by the
change that adds this page.** The owner runs the steps below.

## Defaults this runbook assumes

These are the owner's answers to the open security questions (Morning 28). Change the unit if
an answer changes.

- **Plain HTTP on the LAN for now.** A cookie or bearer crosses the home network in clear text,
  so a sniffer on the LAN could replay a session until the next rotation. TLS is TP-1998.
- **No `tailscale0` bind.** The console listens on one LAN address and on loopback, nothing else.
- **30-day cookies.** Rotation is the global logout.

## What is and is not safe until TLS lands

- **Owner-write LAN routes stay off until TLS (TP-1998) lands.** The console is read-only today.
  The owner inbox's writes (answers, approvals, merge gates) must not be exposed on the LAN
  listener while the traffic is plain HTTP.
- **Logout is per-browser.** `POST /auth/logout` clears the cookie of the browser that sent it.
  A copied cookie stays valid.
- **Only `token rotate` revokes a lost device.** It ends every session and voids every
  outstanding login link at once.

## The unit

Save as `~/.config/systemd/user/titan-console.service`. Replace `<lan-ip>` with the machine's
reserved LAN address (a concrete interface address, never `0.0.0.0` or loopback),
`<basement-hostname>` with its hostname, and `<checkout>` with the path of the titan-platform
checkout that runs the console. `%h` is the user's home directory.

```ini
[Unit]
Description=titan-console (loopback + authenticated LAN on <lan-ip>:7500)
After=active-work.service
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/usr/bin/node <checkout>/apps/console/dist/cli.js
Environment=TITAN_CONSOLE_HOST=<lan-ip>
Environment=TITAN_CONSOLE_LAN_NAMES=<basement-hostname>,<basement-hostname>.local
Environment=PATH=/usr/bin:%h/.local/bin:/bin:/usr/sbin:/sbin
UMask=0077
Restart=always
RestartSec=5
StandardOutput=append:%h/.local/state/titan-console/serve.out.log
StandardError=append:%h/.local/state/titan-console/serve.err.log

[Install]
WantedBy=default.target
```

- `StartLimitIntervalSec=0` lets systemd keep retrying forever. If the router hands the machine
  a different address, the bind fails loudly and the unit keeps retrying instead of giving up
  after five starts.
- There is no setting that serves the LAN without auth, and the unit sets none. The LAN
  listener answers 401 to anything without a session cookie or bearer.
- `TITAN_CONSOLE_TOKEN` is unset, so the secret lives in `lan.token` under
  `~/.local/state/titan-console`, created at mode 0600.
- The console runs from the shared checkout's `dist`, so a broken `dist` there breaks the site
  until it is rebuilt.

## Install

One command each, after TP-1980 is on the checkout's branch.

1. `pnpm build`, in the checkout. The console resolves its sibling packages through `dist/`.
2. `mkdir -p ~/.local/state/titan-console`
3. Write the unit above to `~/.config/systemd/user/titan-console.service`.
4. `systemctl --user daemon-reload`
5. `systemctl --user enable --now titan-console.service`
6. `loginctl show-user "$USER" -p Linger` must print `Linger=yes`; otherwise the unit stops at
   logout. Fix it with `loginctl enable-linger "$USER"`.
7. `curl -s -o /dev/null -w '%{http_code}\n' http://<lan-ip>:7500/` must print `401`.
8. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7500/` must print `200`.
9. If `sudo ufw status` shows ufw active, run
   `sudo ufw allow in on <lan-interface> from <lan-subnet> to any port 7500 proto tcp`.

## Log in

Run this on the machine that runs the console, with the same `TITAN_CONSOLE_*` settings as the
unit (the port, state directory, token path and LAN names decide the link):

```sh
TITAN_CONSOLE_HOST=<lan-ip> TITAN_CONSOLE_LAN_NAMES=<basement-hostname>,<basement-hostname>.local \
  node <checkout>/apps/console/dist/cli.js login-link
```

The link is `http://<basement-hostname>:7500/auth/login?code=...`. It works once and for ten
minutes. Open it on the laptop, press the sign-in button, and repeat with a fresh link on the
phone. A restart of the daemon after minting voids an outstanding link.

## Rotate

```sh
node <checkout>/apps/console/dist/cli.js token rotate
```

Every session and outstanding link ends at once, with no restart. Do this when a device is
lost, then log in again on each device you still use.

## Roll back

```sh
systemctl --user disable --now titan-console.service
```

The console goes back to loopback only. To also revoke every session before a later reinstall,
run `token rotate` first.
