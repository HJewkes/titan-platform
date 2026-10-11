---
"@titan-design/factory": patch
---

On systemd, Shepherd's redeploy now starts `service deploy` in its own transient user unit (`systemd-run --user --collect`), so restarting the service no longer kills the deployer before it confirms health, records the outcome or rolls back. darwin keeps the setsid path. If systemd-run is missing or fails, the deployer falls back to setsid and logs why.
