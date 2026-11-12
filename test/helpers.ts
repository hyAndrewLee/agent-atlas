import { afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
const roots: string[] = [];
export function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "atlas-test-")); roots.push(root);
  const git = spawnSync("git", ["init", "--quiet", "--initial-branch=main", root]);
  if (git.status !== 0) throw new Error(`Cannot create Git fixture: ${git.stderr}`);
  for (const [p, text] of Object.entries(files)) put(root, p, text);
  return root;
}
export function put(root: string, path: string, text: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
export function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string) {
    for (const name of readdirSync(join(root, path)).sort()) {
      const p = path ? `${path}/${name}` : name;
      if (lstatSync(join(root, p)).isDirectory()) { result[p + "/"] = ""; walk(p); }
      else if (!lstatSync(join(root, p)).isSymbolicLink()) result[p] = readFileSync(join(root, p)).toString("base64");
    }
  }
  walk(""); return result;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
