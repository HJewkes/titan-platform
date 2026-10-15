---
"@titan-design/fix-proof": minor
---

`exec` and `run` install, build and test a tree with only a `package-lock.json` through npm
(`npm ci --no-audit --no-fund`, `npm run build --if-present`, `npm exec --no -- vitest run`), so
npm repos such as agent-chat and relay can be proven. pnpm trees are unchanged, and
`.github/fix-proof.json` `build` and `command` still override the defaults.
