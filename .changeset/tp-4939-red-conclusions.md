---
"@titan-design/factory": patch
---

The planner's red-main probe now counts main runs that ended `timed_out` or `startup_failure` as well as `failure`. Cancelled runs stay out, since concurrency cancels on main are routine.
