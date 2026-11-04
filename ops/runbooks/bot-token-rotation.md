# Rotating the factory bot's GitHub token

The factory's bot account acts through one token, read by `titan-factory serve` from the file at
`BOT_TOKEN_PATH` (`products/factory/src/bot-identity.ts`). This runbook replaces that token. It holds for
both host options of TP-3094: (A) serve runs as its own OS user, and (B) serve runs as the owner's user.

The owner chose option B on 2026-10-22, so `<BOT_TOKEN_PATH>` is
`~/.config/titan-factory/secrets/github-bot.token`, in a 0700 dir, with `~` the home dir in serve's passwd entry.
Option A stays below for reference only. Other placeholders: `<serve-user>` is serve's OS user under option A;
`<state-dir>` is serve's state dir (the factory database's dir); serve answers on loopback port 7410 unless
`--port` set another.

Never put the token on a command line, in an environment variable, in a chat message, a brief or a log.
Paste it only at a `read -rs` prompt.

## When to rotate

- serve logs `factory: ops-alarm bot-token-expiry fingerprint=<12 hex> expiresAt=<iso> daysLeft=<n>`.
  It raises that line once per token fingerprint (once more after a restart) when a bot response carries
  GitHub's `github-authentication-token-expiration` header with 14 days or less left.
- `/health.bot.expiresAt` is within 14 days. It is null until the bot's first response, and stays null
  for a token with no expiry.
- `titan-factory bot-token scan` reported a hit: revoke the token on GitHub first, then rotate.
- serve logs `factory: ops-alarm github-auth identity=<bot login>`: the token was revoked or has expired.

## 1. Record the current state

```
curl -s http://127.0.0.1:7410/health | jq '.bot'
cat <state-dir>/bot-token.sha256
```

Keep the fingerprint: step 5 checks that it changed. Under option A, read the file as the serve user
(`sudo -u <serve-user> cat <state-dir>/bot-token.sha256`).

## 2. Make the new token on GitHub

Signed in as the bot, make a token with the same scopes and repositories as the old one and a 90-day expiry.
Do not revoke the old one yet: serve keeps using it until the restart in step 4.

If the classic-token fallback is in use, do the E16 check in section 7 first: it decides which kind of
token to make.

## 3. Write the token file

The new file replaces the old one through a rename, so serve never meets half a token.

**Option A: as the serve user.**

```
sudo -u <serve-user> sh -c 'umask 077; stty -echo; read -r t; stty echo; printf "%s\n" "$t" > <BOT_TOKEN_PATH>.new; chmod 600 <BOT_TOKEN_PATH>.new; mv <BOT_TOKEN_PATH>.new <BOT_TOKEN_PATH>'
```

Paste the token at the prompt and press Enter. Nothing shows on screen (`sh` has no `read -s`, so
`stty -echo` hides it). Then:

```
sudo ls -l <BOT_TOKEN_PATH>
```

The line must start with `-rw-------` and name `<serve-user>` as owner.

**Option B: as the owner's user.** Run one at a time:

```
umask 077
read -rs BOT_TOKEN
```

Paste the token, then press Enter. Nothing shows on screen.

```
printf '%s\n' "$BOT_TOKEN" > <BOT_TOKEN_PATH>.new
unset BOT_TOKEN
chmod 600 <BOT_TOKEN_PATH>.new
mv <BOT_TOKEN_PATH>.new <BOT_TOKEN_PATH>
ls -l <BOT_TOKEN_PATH>
ls -ld "$(dirname <BOT_TOKEN_PATH>)"
```

The file line must start with `-rw-------`, the directory line with `drwx------`.

## 4. Restart serve

serve reads the token once, at start: the capability vault fixes its secret list when the runtime is
built, so a token read later would escape redaction. Writing the file changes nothing until serve restarts.

- Option B (user unit): `titan-factory service restart`. It drains busy runs first.
- Option A (system unit): `sudo systemctl restart titan-factory.service`.

## 5. Reload check

```
curl -s http://127.0.0.1:7410/health | jq '.bot'
cat <state-dir>/bot-token.sha256
```

Under option A, read the fingerprint as the serve user, as in step 1. Pass:

- `.bot.state` is `ok`. `absent` means serve found no file at `<BOT_TOKEN_PATH>`; `refused` names the
  problem (`mode`, `owner`, `symlink`, `malformed`, ...): fix the file and restart again.
- the fingerprint differs from the one recorded in step 1. The same fingerprint means serve still holds
  the old token: the write went to another path, or serve did not restart.
- after the bot's next call, `.bot.expiresAt` is about 90 days out. A null that stays null for a
  fine-grained token means no bot call has run yet.

## 6. Finish

1. Revoke the old token on GitHub (fine-grained: settings, personal access tokens; classic: settings, tokens).
2. Run `titan-factory bot-token scan` as the agents' user. It must exit 0. A hit means the new token
   reached an agent's environment: revoke it and start again at step 2.
3. Delete any copy kept in a password manager if no second copy is wanted.

## 7. E16: the classic-token fallback

Only when the bot runs on a classic token (`ghp_` prefix), because D-P-02's check 1 failed when the bot was
set up. At each rotation, re-run check 1 to see whether a fine-grained token now works:

1. Signed in as the bot, open the fine-grained token form. Check 1 passes at the form when the
   **Resource owner** list offers the account that owns the factory's repos, and each of those repos can be
   picked. If it fails, make a new classic token (`repo` and `workflow` only) and go back to step 3.
2. If the form passes, make the fine-grained token with the scopes of the bot's setup packet, then confirm
   it reads each repo. The token goes through stdin, never argv or the environment:

   ```
   read -rs T
   printf 'Authorization: Bearer %s\n' "$T" | curl -sS -o /dev/null -w '%{http_code}\n' -H @- https://api.github.com/repos/<owner>/<repo>
   unset T
   ```

   Every repo must answer `200`. A `403` or `404` fails check 1: delete the fine-grained token, make a
   classic one, and go back to step 3.
3. If every repo answers `200`, revert to fine-grained: write the fine-grained token (steps 3 to 5), then
   revoke the classic token so only one token is live. Record the check 1 result and the date on TP-3094.
