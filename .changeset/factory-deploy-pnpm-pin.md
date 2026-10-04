---
"@titan-design/factory": patch
---

The deployer's `pnpm install` honors the checkout's `packageManager` pin and runs with `CI=true`, so it purges a foreign modules layout without prompting. It used to pin `manage_package_manager_versions=false`, so a global pnpm 10 installed a v10 layout that every pinned pnpm 9.15 install then prompted to purge, and with no TTY that prompt exited 0 without installing.
