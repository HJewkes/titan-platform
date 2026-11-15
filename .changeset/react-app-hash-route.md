---
"@titan-design/react-app": minor
---

Export `useHashRoute(parse)` and `safeDecode(text)`: a hook that re-renders on `hashchange` with the route `parse` reads from the hash, and a `decodeURIComponent` that keeps a lone `%` raw. The console and codewatch routers use them in place of their own copies.
