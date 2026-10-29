---
"@titan-design/react-app": minor
---

`RpcProvider` and `createQueryStore` take an optional `onSettle` observer. It is called once per finished call with `{ command, ms, ok, fromCache }` and never sees arguments or results; a superseded or aborted call is not reported, and an observer that throws cannot break a query.
