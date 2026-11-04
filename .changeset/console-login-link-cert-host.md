---
"titan-console": patch
---

`titan-console login-link` names a host the LAN certificate covers: the first of `TITAN_CONSOLE_LAN_NAMES` it covers, else the certificate's own name, so a bare run with the hostname defaults no longer prints a link that warns on TLS and gets 403 from the Host check. With `TITAN_CONSOLE_TLS_CERT` unset it reads the one `.crt` under `<state>/tls`, and it refuses when it finds no certificate.
