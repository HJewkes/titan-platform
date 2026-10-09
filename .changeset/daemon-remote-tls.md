---
"@titan-design/daemon": minor
---

The remote listener now speaks only HTTPS. `RemoteListenerOptions.tls: { certFile, keyFile }` is required; a `remote` without it throws `RemoteBindError` before anything binds, so no setting serves plain HTTP beyond loopback. The pair is checked before binding (`TlsFileError` for a missing or unreadable file, a key that is not private to this user or not the certificate's, an expired certificate, or one that does not cover every `allowedHosts` name), and re-read every `tlsReloadMs` (60s) so a renewed certificate is served with no restart; a renewal that fails the checks keeps the last good pair. Remote origins are `https://` only (new `RequestGuardOptions.httpsOnly`), and the session cookie is always `Secure`.
