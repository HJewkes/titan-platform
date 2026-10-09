# TP-2039 runbook: probe the Secure Enclave owner-presence helper on the Mac

For tp-operator, on the owner's Mac. Every step uses the throwaway tag `probe-tp-2039`, whose key
file is `~/Library/Application Support/titan-factory/probe-tp-2039.se`. No step reads, creates or
replaces the owner key (`owner-key.se`, tag `owner-key`), which plan section 5 step B creates later.

Steps marked **DIALOG** show the macOS Touch ID or login-password dialog and wait for the owner at
the Mac. Every other step is non-interactive; if a dialog shows on one of them, cancel it and record
which step it was.

Record each step's output in the pull request.

## 0. Build from the PR branch

```sh
SHA=$(gh pr view 849 --repo HJewkes/titan-platform --json headRefOid --jq .headRefOid)
echo "probing $SHA"
W="$TMPDIR/tp-2039"
mkdir -p "$W"
git -C ~/projects/titan-platform fetch origin "$SHA"
git -C ~/projects/titan-platform show "$SHA:products/factory/native/owner-presence.swift" > "$W/owner-presence.swift"
/usr/bin/swiftc -O "$W/owner-presence.swift" -o "$W/owner-presence"
echo "swiftc exit $?"
H="$W/owner-presence"
```

Expected: `probing <40 hex>`, then `swiftc exit 0`, with no warnings. These are the same flags
`scripts/factory-build-helper.mjs` uses. Record the SHA with the results: the probe proves only
that head. If the PR head moves afterwards, rerun the runbook against the new head.
If the build fails, stop and send the compiler output back to the implementer.

## 1. Usage

```sh
"$H" a b; echo "exit $?"
```

Expected: the four-line usage on stderr, then `exit 64`.

## 2. keygen with the probe tag

```sh
"$H" keygen --tag probe-tp-2039; echo "exit $?"
stat -f '%Sp %N' "$HOME/Library/Application Support/titan-factory/probe-tp-2039.se"
ls "$HOME/Library/Application Support/titan-factory/"
```

Expected: one line of 16 lowercase hex characters (the key id, call it ID), then `exit 0`. Creating
the key needs no presence, so no dialog is expected. The `stat` line starts with `-rw-------`. The
listing shows `probe-tp-2039.se`, and `owner-key.se` only if it existed before this runbook.

## 3. keygen refuses to overwrite

```sh
"$H" keygen --tag probe-tp-2039; echo "exit $?"
```

Expected: `owner-presence: .../probe-tp-2039.se exists; pass --replace to overwrite it` on stderr,
then `exit 4`. The key id from step 2 is unchanged (step 4 checks it).

## 4. pubkey export and key id

```sh
"$H" pubkey --tag probe-tp-2039 | tee "$W/probe.pem"; echo "exit $?"
"$H" pubkey --tag probe-tp-2039 --id; echo "exit $?"
node -e 'const c=require("crypto");const k=c.createPublicKey(require("fs").readFileSync(process.argv[1]));console.log(c.createHash("sha256").update(k.export({type:"spki",format:"der"})).digest("hex").slice(0,16))' "$W/probe.pem"
```

Expected: a PEM block from `-----BEGIN PUBLIC KEY-----` to `-----END PUBLIC KEY-----` (SPKI, about
three base64 lines), then `exit 0`. Then ID from step 2 and `exit 0`. The node line also prints ID.
No dialog.

## 5. sign a fixed statement (DIALOG)

```sh
printf '%s' '{"v":1,"probe":"TP-2039","nonce":"00000000000000000000000000000000"}' > "$W/statement"
"$H" sign --tag probe-tp-2039 -- "TP-2039 probe: sign a fixed statement" < "$W/statement" | tee "$W/sig"; echo "exit $?"
```

**DIALOG:** the owner confirms with Touch ID, or the login password when Touch ID is not available.
Record the dialog's text: it should contain `TP-2039 probe: sign a fixed statement`.

Expected: one line of about 96 base64url characters (`A-Z a-z 0-9 - _`, no `=`), starting with
`ME`, then `exit 0`.

## 6. Verify the signature with node

```sh
node -e 'const c=require("crypto"),f=require("fs"),[p,s,g]=process.argv.slice(1);console.log(c.verify("sha256",f.readFileSync(s),{key:f.readFileSync(p,"utf8"),dsaEncoding:"der"},Buffer.from(f.readFileSync(g,"utf8").trim(),"base64url")))' "$W/probe.pem" "$W/statement" "$W/sig"
printf ' ' >> "$W/statement"
node -e 'const c=require("crypto"),f=require("fs"),[p,s,g]=process.argv.slice(1);console.log(c.verify("sha256",f.readFileSync(s),{key:f.readFileSync(p,"utf8"),dsaEncoding:"der"},Buffer.from(f.readFileSync(g,"utf8").trim(),"base64url")))' "$W/probe.pem" "$W/statement" "$W/sig"
```

Expected: `true`, then `false` (the second run verifies a statement with one byte appended). This is
the same call TP-2038's `verifyProof` makes.

## 7. Cancel refuses (DIALOG)

```sh
"$H" sign --tag probe-tp-2039 -- "TP-2039 probe: press Cancel" < "$W/statement"; echo "exit $?"
```

**DIALOG:** the owner presses Cancel.

Expected: nothing on stdout, `owner-presence: not signed: ...` on stderr, then `exit 1`.

## 8. Missing key refuses

```sh
"$H" sign --tag probe-tp-2039-absent -- "TP-2039 probe: missing key" < "$W/statement"; echo "exit $?"
```

Expected: `owner-presence: no key at .../probe-tp-2039-absent.se; run owner-presence keygen` on
stderr, then `exit 3`. No dialog.

## 9. The original no-subcommand behaviour (DIALOG)

```sh
"$H" "TP-2039 probe: plain presence"; echo "exit $?"
```

**DIALOG:** the owner confirms.

Expected: one lowercase v4 UUID, then `exit 0`, as before this change.

## 10. Delete the probe key

```sh
rm "$HOME/Library/Application Support/titan-factory/probe-tp-2039.se"
"$H" pubkey --tag probe-tp-2039; echo "exit $?"
rm -r "$W"
ls "$HOME/Library/Application Support/titan-factory/"
```

Expected: `owner-presence: no key at .../probe-tp-2039.se; run owner-presence keygen` and `exit 3`.
The final listing has no `probe-tp-2039.se`. A CryptoKit Secure Enclave key is not a keychain item,
and the enclave keeps no copy: the key file is the only handle, so removing it destroys the key.
