import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEATS, seatQueueFile } from "../test-support/owner-queue-10-05.js";
import { morningQueueItems, queueAsk, readQueueAsks } from "./queues.js";

const LONG = `Decide ${"y".repeat(400)} \`tool run --long\``;
const QUEUE = `# Queue: seat-a

## Morning queue (owner only)

4. **widgets#11:** \`acme/widgets 11 ${"cd".repeat(20)} ~/src/widgets\`
5. Pick a colour for the badge, after T-4.
6. \`tool done T-9\`
7. ${LONG}
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "queues-port-"));
  writeFileSync(join(dir, "seat-a.md"), QUEUE);
  for (const seat of SEATS.slice(1)) writeFileSync(join(dir, `${seat}.md`), seatQueueFile(seat));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readQueueAsks through the Morning QueueSource", () => {
  it("returns exactly the asks the direct parse gives", async () => {
    const seats = ["seat-a", ...SEATS.slice(1), "seat-missing"];
    const direct = seats.flatMap((seat) => {
      const file = join(dir, `${seat}.md`);
      return existsSync(file) ? morningQueueItems(readFileSync(file, "utf8")).map((item) => queueAsk(seat, item)) : [];
    });

    expect(await readQueueAsks(dir, seats)).toStrictEqual(direct);
  });
});
