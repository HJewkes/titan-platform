# Serving the console over the tailnet

This is the install runbook for `titan-console.service`, a systemd user unit that runs the
console on loopback and, behind TLS and authentication, on the machine's tailscale address.
The code is in [the README's LAN mode section](../README.md#lan-mode). **Nothing here is
installed by the change that adds this page.** The owner, or the seat that installs on their
behalf, runs the steps below.

## What the owner decided

Morning 28 asked how the console should be reached from other devices. The answer was
"HTTPS first via tailscale", and it supersedes the plain-HTTP defaults this page used to
carry:

- **No plain HTTP off loopback.** The remote listener speaks only TLS. A plain-HTTP request to
  it gets no reply at all, and there is no setting that turns TLS off.
- **The listener binds the tailscale address**, not the home LAN address, so nothing on the
  home LAN answers on port 7500. Every phone or laptop that uses the console joins the tailnet.
- **The certificate comes from `tailscale cert`**, for the machine's tailnet name, and the
  daemon terminates TLS itself. `tailscale serve` is not used: a proxy in front of the listener
  would leave the listener answering plain HTTP, and every request would arrive from a local
  address, which voids the `peerLocal` check owner writes rely on.
- **The session cookie is `Secure`**, `HttpOnly` and `SameSite=Strict`, and lasts 30 days.
  Rotation is the global logout.

## What is and is not safe

- **Owner writes stay off** (`TITAN_CONSOLE_OWNER_WRITES` unset) in this install. Turning them
  on is a later, separate owner step.
- **A request from this machine is never the owner.** It arrives from one of the machine's own
  addresses, even through the tailscale address, so owner writes refuse it.
- **Logout is per-browser.** `POST /auth/logout` clears the cookie of the browser that sent it.
  A copied cookie stays valid.
- **Only `token rotate` revokes a lost device.** It ends every session and voids every
  outstanding login link at once. Removing the device from the tailnet also cuts it off.

## Before you start

Find two values on the machine that runs the console. Neither goes into this repository.

- `<tailnet-ip>`: the machine's tailscale IPv4 address, from `tailscale ip -4`.
- `<fqdn>`: its tailnet name, such as `box.example.ts.net`, from
  `tailscale status --json`, field `Self.DNSName`, without the trailing dot.

HTTPS certificates must be enabled for the tailnet (MagicDNS on, then HTTPS on, in the
tailscale admin console's DNS page). `tailscale cert` fails until they are.

## The certificate

`tailscale cert` needs root, or a tailscale operator, and writes the files as whoever ran it.
The console refuses a key that is not its own user's and mode 0600, so hand both files over.

1. `mkdir -p -m 0700 ~/.local/state/titan-console/tls`
2. `sudo tailscale cert --cert-file "$HOME/.local/state/titan-console/tls/<fqdn>.crt" --key-file "$HOME/.local/state/titan-console/tls/<fqdn>.key" <fqdn>`
3. `sudo chown "$USER": "$HOME/.local/state/titan-console/tls/<fqdn>.crt" "$HOME/.local/state/titan-console/tls/<fqdn>.key"`
4. `chmod 600 "$HOME/.local/state/titan-console/tls/<fqdn>.key"`

The daemon checks the pair before it binds anything. A missing or unreadable file, a key that
is not the certificate's, an expired certificate, or a certificate that does not cover every
name in `TITAN_CONSOLE_LAN_NAMES` fails the start, and no pid file is written.

## Renewal

Tailscale certificates last about 90 days. Run step 2 to 4 again before they expire; a weekly
root timer is enough, since `tailscale cert` only fetches a new certificate near expiry.

**The daemon needs no restart.** It checks both files once a minute and serves a changed pair to
new connections. If the new files cannot be served (half written, still root's, or mismatched)
it logs an error, keeps serving the last good pair, and tries again a minute later. It never
falls back to plain HTTP.

## The unit

Save as `~/.config/systemd/user/titan-console.service`. Replace `<tailnet-ip>` and `<fqdn>` with
the values above and `<checkout>` with the path of the titan-platform checkout that runs the
console. `%h` is the user's home directory.

```ini
[Unit]
Description=titan-console (loopback + HTTPS on the tailnet, port 7500)
After=active-work.service
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/usr/bin/node <checkout>/apps/console/dist/cli.js
Environment=TITAN_CONSOLE_HOST=<tailnet-ip>
Environment=TITAN_CONSOLE_LAN_NAMES=<fqdn>
Environment=TITAN_CONSOLE_TLS_CERT=%h/.local/state/titan-console/tls/<fqdn>.crt
Environment=TITAN_CONSOLE_TLS_KEY=%h/.local/state/titan-console/tls/<fqdn>.key
Environment=PATH=/usr/bin:%h/.local/bin:/bin:/usr/sbin:/sbin
UMask=0077
Restart=always
RestartSec=5
StandardOutput=append:%h/.local/state/titan-console/serve.out.log
StandardError=append:%h/.local/state/titan-console/serve.err.log

[Install]
WantedBy=default.target
```

- `StartLimitIntervalSec=0` lets systemd keep retrying forever. Until `tailscaled` is up the
  tailnet address is not on any interface, so the start fails loudly and retries instead of
  giving up after five starts.
- `TITAN_CONSOLE_LAN_NAMES` is the tailnet name alone. The hostname defaults are not on the
  certificate, so leaving the variable unset fails the start.
- There is no setting that serves the tailnet without TLS or without auth, and the unit sets
  none. The listener answers 401 to anything without a session cookie or bearer.
- `TITAN_CONSOLE_TOKEN` is unset, so the secret lives in `lan.token` under
  `~/.local/state/titan-console`, created at mode 0600.
- `TITAN_CONSOLE_OWNER_WRITES` is unset, so owner writes stay off.

## Install

One command each.

1. `pnpm build`, in the checkout. The console resolves its sibling packages through `dist/`.
2. Write the certificate as above.
3. Write the unit above to `~/.config/systemd/user/titan-console.service`.
4. `systemctl --user daemon-reload`
5. `systemctl --user enable --now titan-console.service`
6. `loginctl show-user "$USER" -p Linger` must print `Linger=yes`; otherwise the unit stops at
   logout. Fix it with `loginctl enable-linger "$USER"`.
7. If `sudo ufw status` shows ufw active, run
   `sudo ufw allow in on tailscale0 to <tailnet-ip> port 7500 proto tcp`.

## Check it

Run each check and compare. The first two can run on the machine itself or on another
tailnet device.

| Command | Must show |
| --- | --- |
| `curl -s -o /dev/null -w '%{http_code}\n' https://<fqdn>:7500/` | `401`, with no certificate error |
| `curl -sS http://<tailnet-ip>:7500/` | `curl: (52) Empty reply from server`: plain HTTP gets no reply |
| `curl -sS http://<lan-ip>:7500/` | `Connection refused`: nothing listens on the home LAN address |
| `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7500/` | `200`: loopback is unchanged |
| `ss -ltn 'sport = :7500'` | Two listeners: `127.0.0.1:7500` and `<tailnet-ip>:7500`, no wildcard |

`<lan-ip>` is the machine's home LAN address, from `ip -4 addr`.

## Log in

Run this on the machine that runs the console, with the unit's port, state directory, token path
and LAN names (those decide the link; the unit sets only the LAN names away from the defaults):

```sh
TITAN_CONSOLE_LAN_NAMES=<fqdn> node <checkout>/apps/console/dist/cli.js login-link
```

The link is `https://<fqdn>:7500/auth/login?code=...`. It works once and for ten minutes. Open
it on a tailnet device, press the sign-in button, and repeat with a fresh link on the next
device. A restart of the daemon after minting voids an outstanding link.

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
