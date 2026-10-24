---
"titan-console": minor
---

Tap a deposit's `deploy-pause-clear` op from the inbox (TP-3939 S6). `deploy-pause-clear` joins `CONSOLE_OPS`, so its deposit gets a "Clear deploy pause" tap. The read-back shows the failure pause the factory reads now (when, over which target, why, rollback status) and says "the deploy pacer resumes and may deploy within about a minute", or that a manual hold keeps deploys held. The tap is offered only while the pause is the one the deposit names and no deployer is running. The factory's `pause-cleared` answer lands as a success, a `moved` with `currentPause` reads as a newer pause that is kept, and a `deploying` refusal names the running deployer.
