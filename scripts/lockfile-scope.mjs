// Which workspace members a pnpm-lock.yaml change reaches, so one package's dependency bump does not run the whole
// suite. pnpm v9 keys importers by dir and resolves their dependencies to snapshots keyed `name@version(peers)`.
import { parse } from "yaml";

const GRAPH_SECTIONS = new Set(["importers", "packages", "snapshots"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const ROOT_IMPORTER = ".";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A `packages:` key has no peer suffix, so a changed entry matches every snapshot of that version, peers aside.
const withoutPeers = (key) => key.replace(/\(.*$/, "");
const full = (why) => ({ kind: "full", reason: `pnpm-lock.yaml: ${why}` });

function parseLock(text) {
  try {
    const lock = parse(text);
    return lock?.importers && typeof lock.importers === "object" ? lock : null;
  } catch {
    return null;
  }
}

function changedKeys(base = {}, head = {}) {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(head ?? {})]);
  return [...keys].filter((key) => !same(base?.[key], head?.[key]));
}

/** The snapshot keys an importer or snapshot entry depends on; an alias's ref is already a whole key. */
function resolveDeps(entry, snapshots) {
  const refs = DEP_FIELDS.flatMap((field) => Object.entries(entry?.[field] ?? {}));
  return refs.flatMap(([name, ref]) => {
    const version = ref?.version ?? ref;
    return [`${name}@${version}`, version].filter((key) => key in snapshots).slice(0, 1);
  });
}

function reachedKeys(lock, importer) {
  const snapshots = lock.snapshots ?? {};
  const seen = new Set();
  const queue = resolveDeps(lock.importers[importer], snapshots);
  while (queue.length > 0) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(...resolveDeps(snapshots[key], snapshots));
  }
  return new Set([...seen].map(withoutPeers));
}

/** Importers on either side that reach a changed entry, and the first entry no importer reaches. */
function importersReaching(changed, locks) {
  const importers = new Set();
  const reached = new Set();
  if (changed.size === 0) return { importers: [], untraced: undefined };
  for (const lock of locks) {
    for (const importer of Object.keys(lock.importers)) {
      const hits = [...reachedKeys(lock, importer)].filter((key) => changed.has(key));
      if (hits.length > 0) importers.add(importer);
      hits.forEach((key) => reached.add(key));
    }
  }
  return { importers: [...importers], untraced: [...changed].find((key) => !reached.has(key)) };
}

/**
 * The member dirs a lockfile change touches, or full when the change reaches the root's tooling, cannot be traced to
 * an importer, or a side does not parse. `sides` holds the lockfile text at the merge base and at the head.
 */
export function lockfileScope(sides, memberDirs) {
  const [base, head] = [parseLock(sides?.base), parseLock(sides?.head)];
  if (!base || !head) return full("a side does not parse");
  const other = changedKeys(base, head).find((key) => !GRAPH_SECTIONS.has(key));
  if (other) return full(`${other} changed`);
  const changedImporters = changedKeys(base.importers, head.importers);
  const entries = [...changedKeys(base.packages, head.packages), ...changedKeys(base.snapshots, head.snapshots)];
  const traced = importersReaching(new Set(entries.map(withoutPeers)), [base, head]);
  if (traced.untraced) return full(`${traced.untraced} reaches no importer`);
  const importers = [...new Set([...changedImporters, ...traced.importers])];
  if (importers.includes(ROOT_IMPORTER)) return full("the root importer changed or reaches a changed entry");
  const dirs = importers.map((importer) => `${importer}/`);
  const stray = dirs.find((dir) => !memberDirs.includes(dir));
  return stray ? full(`importer ${stray} is not a workspace member`) : { kind: "dirs", dirs };
}
