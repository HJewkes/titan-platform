import { runChoreSpec } from "./workflows/post-merge.js";
import { hostChoreSpec } from "./workflows/post-merge-adapter.js";

/** What a post-merge chore's transient unit runs: the chore, then its result file, outside serve's cgroup. */
await runChoreSpec(process.argv[2] ?? "", hostChoreSpec());
