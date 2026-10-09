# pm: use this when

You need to validate or type an active-work task record (id, title, priority, status, dates and the optional severity, estimate, done_when, tags, notes, parent and dep), read a task's parent and dep edges with `readEdges`, or check a proposed edge change for unknown ids and cycles with `checkEdges`. Pure code; it reads no files, so parse the task YAML in the host and hand the objects over. For a seat's front matter use `coordinator` instead.
