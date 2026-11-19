import { expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, put } from "./helpers.ts";
import { summaries, SUMMARIES } from "../src/summaries.ts";
const git = (root: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd: root });
  if (r.status) throw new Error(String(r.stderr));
};
function setup() {
  const root = fixture({ "README.md": "mixed language project", "src/api/main.py": "def serve(): pass", "src/lib/core.go": "package lib", "src/lib/extra.ts": "export const x=1" });
  git(root, "add", "."); git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
  const runner = join(root, "runner.js");
  put(root, "runner.js", `#!/usr/bin/env bun
let input=''; for await (const part of Bun.stdin.stream()) input+=new TextDecoder().decode(part);
const x=JSON.parse(input); if (process.argv[2]==='fail') process.exit(2);
if(x.role==='review') { console.log(JSON.stringify({valid:process.argv[2]!=='reject'})); }
else { const source=x.context.directFiles[0]?.path ?? x.context.children[0]?.[1]?.evidence[0]; console.log(JSON.stringify({description:'Purpose of '+x.context.directory+' ('+source+')',evidence:[source]})); }
`);
  chmodSync(runner, 0o755);
  return { root, runner };
}
test("polyglot bottom-up summaries, incremental rename/delete/modify and no-op", () => {
  const { root, runner } = setup();
  const refresh = () => summaries(root, "HEAD", runner, "author", "critic", true);
  expect(refresh()).toEqual({ changed: true, directories: 4 });
  const before = JSON.parse(readFileSync(join(root, SUMMARIES), "utf8"));
  expect(Object.keys(before.directories)).toEqual([".", "src", "src/api", "src/lib"]);
  expect(refresh()).toEqual({ changed: false, directories: 4 });
  expect(summaries(root, "HEAD", runner, "author", "critic")).toMatchObject({ fresh: true });
  put(root, "src/api/main.py", "def changed(): pass");
  git(root, "mv", "src/lib/core.go", "src/lib/new.go");
  expect(summaries(root, "HEAD", runner, "author", "critic")).toMatchObject({ fresh: false });
  refresh();
  const next = JSON.parse(readFileSync(join(root, SUMMARIES), "utf8"));
  expect(next.directories["src/lib"].evidence.every((p: string) => p !== "src/lib/core.go")).toBe(true);
  expect(next.directories["src/api"].description).toBe(before.directories["src/api"].description); // same text is allowed
  rmSync(join(root, "src/api/main.py"));
  refresh();
  expect(JSON.parse(readFileSync(join(root, SUMMARIES), "utf8")).directories["src/api"]).toBeUndefined();
});
test("rejected model, changed source and symlink do not activate partial output", () => {
  const { root, runner } = setup();
  summaries(root, "HEAD", runner, "author", "critic", true);
  const before = readFileSync(join(root, SUMMARIES), "utf8");
  const rejected = setup();
  expect(() => summaries(rejected.root, "HEAD", rejected.runner, "author", "reject", true)).toThrow("Reviewer rejected");
  expect(() => readFileSync(join(rejected.root, SUMMARIES))).toThrow();
  put(root, "src/api/main.py", "changed");
  expect(() => summaries(root, "HEAD", runner, "author", "reject", true)).toThrow("Incompatible");
  expect(() => summaries(root, "HEAD", runner, "author", "critic", true, () => put(root, "src/api/main.py", "changed again"))).toThrow("Sources or output changed");
  expect(readFileSync(join(root, SUMMARIES), "utf8")).toBe(before);
  symlinkSync("README.md", join(root, "alias")); git(root, "add", "alias");
  expect(summaries(root, "HEAD", runner, "author", "critic")).toMatchObject({ fresh: false });
});
