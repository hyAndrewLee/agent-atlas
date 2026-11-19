import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  build,
  fail,
  hash,
  inventory,
  inventoryHash,
  json,
  parseRules,
  safePath,
  type Rules,
  type Snapshot,
} from "./engine.ts";

export const EXTENSION = ".pi/extensions/agent-atlas.ts";
export const SKILL = ".agent-atlas/skill/SKILL.md";
export const RUNTIME = ".agent-atlas/runtime.mjs";
export const RULES = ".agent-atlas/rules.json";
export type Current = { version: 1; snapshot: string; artifacts: Record<string, string> };
const exists = (root: string, path: string) => existsSync(safePath(root, path));
export function read(root: string, path: string): string {
  return readFileSync(safePath(root, path), "utf8");
}
export function installed(root: string) {
  return exists(root, ".agent-atlas");
}
export function load(root: string): {
  current: Current;
  rules: Rules;
  snapshot: Snapshot;
  rulesText: string;
} {
  const current = JSON.parse(read(root, ".agent-atlas/current.json")) as Current;
  if (
    current.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(current.snapshot) ||
    !current.artifacts ||
    Object.keys(current.artifacts).sort().join("|") !== [EXTENSION, RUNTIME, SKILL].sort().join("|")
  )
    fail("Invalid Agent Atlas ownership pointer; restore from version control");
  for (const [path, digest] of Object.entries(current.artifacts))
    if (hash(read(root, path)) !== digest)
      fail(
        `Edited generated artifact conflict: ${path}. Restore the original or remove the installation manually; nothing overwritten.`,
      );
  const bytes = read(root, `.agent-atlas/snapshots/${current.snapshot}.json`);
  if (hash(bytes) !== current.snapshot)
    fail("Edited generated snapshot conflict; restore original bytes");
  const snapshot = JSON.parse(bytes) as Snapshot;
  if (snapshot.version !== 1) fail("Unsupported snapshot version");
  const rulesText = read(root, RULES);
  return { current, rules: JSON.parse(rulesText), snapshot, rulesText };
}

export function check(root: string) {
  const state = load(root);
  // ponytail: full content hashing, but do not reparse unchanged trees. Incremental
  // inventories are a later optimization only after representative measurements.
  if (
    inventoryHash(inventory(root)) === state.snapshot.inputHash &&
    hash(json(parseRules(state.rules))) === state.snapshot.rulesHash
  )
    return { ...state, next: state.snapshot, fresh: true };
  const next = build(root, state.rules, state.snapshot);

  return { ...state, next, fresh: json(next) === json(state.snapshot) };
}

export function lock<T>(root: string, fn: () => T): T {
  root = realpathSync(root);
  const path = safePath(root, ".agent-atlas.lock");
  try {
    mkdirSync(path);
  } catch (e: any) {
    if (e.code === "EEXIST")
      fail(
        "Another Atlas writer or interrupted operation owns .agent-atlas.lock. Do not remove it until that operation has stopped.",
      );
    throw e;
  }

  const inode = lstatSync(path).ino;
  try {
    return fn();
  } finally {
    if (lstatSync(path).ino !== inode) fail("Writer lock changed; refusing cleanup");
    rmSync(path, { recursive: true });
  }
}

export function assertFresh(root: string, next: Snapshot, rulesText: string) {
  if (inventoryHash(inventory(root)) !== next.inputHash || read(root, RULES) !== rulesText)
    fail(
      "Sources or rules changed during indexing; retry refresh. Previous navigation remains active.",
    );
}
export function refresh(
  root: string,
  beforePublish?: () => void,
): { changed: boolean; snapshot: Snapshot } {
  // Validate before taking a writer lock: ordinary ambiguity is entirely read-only.
  const planned = check(root);
  if (planned.fresh) return { changed: false, snapshot: planned.snapshot };

  return lock(root, () => {
    const state = check(root);
    if (state.fresh) return { changed: false, snapshot: state.snapshot };
    beforePublish?.();
    assertFresh(root, state.next, state.rulesText);

    // Recheck ownership immediately before publishing, including externally edited artifacts.
    const again = load(root);
    if (json(again.current) !== json(state.current))
      fail("Atlas pointer changed during indexing; retry");
    const bytes = json(state.next);
    const digest = hash(bytes);
    const snapshotPath = `.agent-atlas/snapshots/${digest}.json`;
    const pointerTemp = `.agent-atlas/.current-${randomUUID()}`;
    let created = false;
    try {
      if (exists(root, snapshotPath)) {
        if (read(root, snapshotPath) !== bytes) fail("Immutable snapshot conflict");
      } else {
        writeFileSync(safePath(root, snapshotPath), bytes, { flag: "wx" });
        created = true;
      }
      writeFileSync(safePath(root, pointerTemp), json({ ...state.current, snapshot: digest }), {
        flag: "wx",
      });
      assertFresh(root, state.next, state.rulesText);
      if (json(load(root).current) !== json(state.current))
        fail("Atlas ownership pointer changed before publication; retry");
      renameSync(safePath(root, pointerTemp), safePath(root, ".agent-atlas/current.json"));
    } catch (e) {
      if (created) rmSync(safePath(root, snapshotPath));
      throw e;
    } finally {
      rmSync(safePath(root, pointerTemp), { force: true });
    }
    return { changed: true, snapshot: state.next };
  });
}
