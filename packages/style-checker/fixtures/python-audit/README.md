# Captured Python audit output

Real output from the commands the Tier B runners issue, captured on 2026-09-23 with the
tools installed in a throwaway venv (`python3 -m venv`, `pip install vulture pydoclint
pyright import-linter`) under Python 3.14.3. The Python sources are in `project/` and
`layered/`. The only edit is that pyright's absolute paths were rewritten to `/project`.

| File | Command, run from | Tool | Exit |
|---|---|---|---|
| `vulture.stdout.txt`, `vulture.stderr.txt` | `vulture --min-confidence 60 pkg broken.py`, `project/` | vulture 2.16 | 3 |
| `pydoclint.stderr.txt` (stdout was empty) | `pydoclint --style numpy --quiet pkg broken.py`, `project/` | pydoclint 0.9.1 | 1 |
| `pyright.stdout.json` | `pyright --outputjson -p <tmp>/pyrightconfig.json pkg broken.py`, `project/` | pyright 1.1.414 (pip wrapper) | 1 |
| `import-linter.stdout.txt` | `lint-imports --no-logo --no-cache`, `project/` | import-linter 2.15 | 1 |
| `import-linter-layered.stdout.txt` | `lint-imports --no-logo --no-cache`, `layered/` | import-linter 2.15 | 1 |

The pyright config is what `generatePyrightAuditConfig` produces for `project/`.
pydoclint prints its violations on stderr, not stdout. vulture exits 3 when it finds dead
code and reports a file it cannot parse on stderr. lint-imports orders the chains of a
layers contract differently from run to run; the test follows the captured order.
