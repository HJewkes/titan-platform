---
"@titan-design/factory": patch
---

Settle an autoresearch eval whose process is killed from outside, for example by the kernel's OOM killer. The step now fails with an error that names the signal ("killed by SIGKILL") instead of "exit null". Two seconds after the script exits, its pipes are cut, so a descendant that still holds stdout can no longer keep the step, or a stop of the evals, waiting for ever.
