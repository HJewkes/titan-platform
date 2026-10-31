import { describe, expect, it } from "vitest";
import { checkCurrent, EXIT, rootFrom, type StartPorts } from "../../deploy/titan-console-start-check.mts";

const ROOT = "/srv/console";
const LINK = `${ROOT}/current`;
const BROKEN = "a".repeat(40);
const OLDER = "b".repeat(40);
const NEWER = "c".repeat(40);
const release = (sha: string): string => `${ROOT}/releases/${sha}`;
const stamp = (sha: string, builtAt: string): string => JSON.stringify({ sha, builtAt, dirty: false });

interface Fake {
  ports: StartPorts;
  files: Map<string, string>;
  links: Map<string, string>;
  lines: string[];
}

/** Each release has a bin with bytes and a stamp naming its own sha, unless a test empties it. */
function fakePorts(shas: readonly string[] = [BROKEN, OLDER, NEWER]): Fake {
  const files = new Map<string, string>();
  shas.forEach((sha, n) => {
    files.set(`${release(sha)}/apps/console/dist/cli.js`, "#!/usr/bin/env node");
    files.set(`${release(sha)}/apps/console/dist/build-info.json`, stamp(sha, `2031-03-0${n + 1}T12:00:00.000Z`));
  });
  const links = new Map([[LINK, release(BROKEN)]]);
  const lines: string[] = [];
  const ports: StartPorts = {
    readLink: (link) => links.get(link),
    swapLink: (link, target) => void links.set(link, target),
    listDirs: () => [...shas],
    fileSize: (file) => files.get(file)?.length,
    readFile: (file) => files.get(file),
    log: (line) => void lines.push(line),
  };
  return { ports, files, links, lines };
}

const emptied = (fake: Fake, sha: string): Fake => {
  for (const key of fake.files.keys()) if (key.startsWith(release(sha))) fake.files.set(key, "");
  return fake;
};

describe("the start check before titan-console.service runs current", () => {
  it("starts a whole build without a word or a swap", () => {
    const fake = fakePorts();

    expect(checkCurrent(fake.ports, ROOT)).toBe(EXIT.OK);

    expect(fake.links.get(LINK)).toBe(release(BROKEN));
    expect(fake.lines).toEqual([]);
  });

  // TP-4638: after a power loss every file in the served release was 0 bytes, and node exited 0 on the empty cli.js.
  it("points current at the newest whole release when a power loss emptied the served one", () => {
    const fake = emptied(fakePorts(), BROKEN);

    expect(checkCurrent(fake.ports, ROOT)).toBe(EXIT.OK);

    expect(fake.links.get(LINK)).toBe(release(NEWER));
    expect(fake.lines[0]).toBe(`error: ${release(BROKEN)} cannot start: apps/console/dist/cli.js is empty`);
    expect(fake.lines[1]).toMatch(new RegExp(`^pointed ${LINK} at ${release(NEWER)}, built 2031-03-03`));
  });

  it("falls back when the served bin has bytes but its build-info is unreadable, skipping an emptied candidate", () => {
    const fake = emptied(fakePorts(), NEWER);
    fake.files.set(`${release(BROKEN)}/apps/console/dist/build-info.json`, "{");

    expect(checkCurrent(fake.ports, ROOT)).toBe(EXIT.OK);

    expect(fake.links.get(LINK)).toBe(release(OLDER));
    expect(fake.lines[0]).toBe(`error: ${release(BROKEN)} cannot start: apps/console/dist/build-info.json is unreadable`);
  });

  it("exits non-zero, saying why, when no release is whole, so systemd does not loop on exit 0", () => {
    const fake = fakePorts([BROKEN]);
    emptied(fake, BROKEN);

    expect(checkCurrent(fake.ports, ROOT)).toBe(EXIT.NO_BUILD);

    expect(fake.links.get(LINK)).toBe(release(BROKEN));
    expect(fake.lines.at(-1)).toBe(`error: no whole release under ${ROOT}/releases; not starting the console`);
  });

  it("exits non-zero when current is not a symlink", () => {
    const fake = fakePorts();
    fake.links.clear();

    expect(checkCurrent(fake.ports, ROOT)).toBe(EXIT.NO_BUILD);
  });

  it("reads the same update root as the bootstrap", () => {
    expect(rootFrom({ TITAN_CONSOLE_UPDATE_ROOT: "/srv/elsewhere" })).toBe("/srv/elsewhere");
  });
});
