# Captured ruff output

Real output from `ruff check --config <config> --output-format json <files>`, the command
the ruff runner issues, run through `pipx run ruff` on 2026-09-18. The config is
`[lint]` with `select = ["N"]`; `bad-config` uses `selct` instead. The only edit is that
absolute paths were rewritten to `/project`, `/empty` and `/config`. The Python sources are
in `project/`.

| Case | Files | ruff | Exit | Captured |
|---|---|---|---|---|
| `clean` | `clean.py` | 0.16.8 | 0 | stdout |
| `findings` | `findings.py` | 0.16.8 | 1 | stdout |
| `syntax-error` | `findings.py broken.py` | 0.16.8 | 1 | stdout |
| `syntax-error-ruff-0.9.10` | `findings.py broken.py` | 0.9.10 | 1 | stdout |
| `missing-file` | `findings.py nope.py` | 0.16.8 | 1 | stdout, stderr |
| `empty-dir` | an empty directory | 0.16.8 | 0 | stdout, stderr |
| `bad-config` | `clean.py` | 0.16.8 | 2 | stderr (stdout was empty) |

A missing file alone exits 0 with `[]` on stdout; only stderr says it was not linted.
A syntax error is `"code": "invalid-syntax"` in 0.16.8 and `"code": null` with a
`SyntaxError: ` message prefix in 0.9.10. Only 0.16.8 emits `name` and `severity`, and
its `severity` is `"error"` for every entry, rule findings included.
