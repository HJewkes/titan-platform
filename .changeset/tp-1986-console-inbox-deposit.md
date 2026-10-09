---
"titan-console": patch
---

Add `inbox.deposit`, the console's first deposit-class command, and `titan-console inbox file [<json>|-]`. Agents file one owner item into the spool at `TITAN_CONSOLE_INBOX_DIR`. The command refuses system fields with 400, a deposit over 64 KB with 400, and an asker's 201st open deposit with 429. A repeat `depositId` returns the item id it already has.
