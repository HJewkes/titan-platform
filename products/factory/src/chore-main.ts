import { runChoreSpec } from "./workflows/post-merge.js";

/** What a post-merge chore's transient unit runs: the chore, then its result file, outside serve's cgroup. */
await runChoreSpec(process.argv[2] ?? "");
