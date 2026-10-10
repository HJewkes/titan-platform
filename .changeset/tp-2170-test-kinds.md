---
"@titan-design/code-graph": minor
---

Add Python code-kind and test-kind metrics (TP-2170). Per function: `symbol_kind_output_boundary`, `symbol_kind_parser`, `symbol_kind_io`, `symbol_kind_pure`, plus the local facts `symbol_output_signal`, `symbol_state_writes` and `symbol_unlisted_calls`. Per pytest test: `test_kind_snapshot`, `test_kind_exact_output`, `test_kind_loose_output`, `test_kind_error_path`, `test_kind_property`, `test_kind_roundtrip`. Per source function a test reaches: `symbol_tests_snapshot`, `symbol_tests_exact_output`, `symbol_tests_loose_output_only`, `symbol_tests_error_path`, `symbol_tests_property`, `symbol_tests_roundtrip`. Python `calls` edges now include `runner.invoke(cmd, ...)` as a call to `cmd`. The test linker now pairs pytest's `test_<name>.py` with the one non-test `<name>.py`. `INDEX_VERSION` is now 0.27.0, so the first index after upgrading reparses every file.
