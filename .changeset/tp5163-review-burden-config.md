---
"@titan-design/review-burden": minor
---

The `review-burden` bin takes `--config <file>`: a JSON object with any of `protectedPaths`,
`storedDataGlobs`, `generatedGlobs`, `testGlobs`, `ignoredGlobs`, `migrationGlobs` and `apiGlobs`, each
replacing its default. An unreadable file, bad JSON, an unknown key or a non-string-array value exits 2. It
also reads both sides of every changed `package.json`, so `package-key-removed` facts reach the JSON line.
