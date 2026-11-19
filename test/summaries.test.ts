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
require('node:fs').appendFileSync(${JSON.stringify(join(root, "calls.jsonl"))}, JSON.stringify({role:x.role,directory:x.context.directory,children:x.context.children.map(([p])=>p)})+'\\n');
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
  const bytes = readFileSync(join(root, SUMMARIES), "utf8");
  const calls = readFileSync(join(root, "calls.jsonl"), "utf8");
  expect(summaries(root, "HEAD", runner, "author", "critic")).toMatchObject({ fresh: true });
  expect(refresh()).toEqual({ changed: false, directories: 4 });
  expect(readFileSync(join(root, SUMMARIES), "utf8")).toBe(bytes);
  expect(readFileSync(join(root, "calls.jsonl"), "utf8")).toBe(calls);
  rmSync(join(root, "src/api/main.py"));
  refresh();
  expect(JSON.parse(readFileSync(join(root, SUMMARIES), "utf8")).directories["src/api"]).toBeUndefined();
});
test("bottom-up ordering includes one-level children and new files refresh only ancestors", () => {
  const { root, runner } = setup();
  const refresh = () => summaries(root, "HEAD", runner, "author", "critic", true);
  refresh();
  const calls = () => readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls().filter(x => x.role === "summarize").map(x => x.directory)).toEqual(["src/api", "src/lib", "src", "."]);
  expect(calls().find(x => x.directory === ".").children).toEqual(["src"]);
  const before = JSON.parse(readFileSync(join(root, SUMMARIES), "utf8"));
  rmSync(join(root, "calls.jsonl"));
  put(root, "src/api/new.py", "def new_file(): pass"); git(root, "add", "src/api/new.py");
  refresh();
  expect(calls().filter(x => x.role === "summarize").map(x => x.directory)).toEqual(["src/api", "src", "."]);
  expect(calls().length).toBe(6);
  expect(JSON.parse(readFileSync(join(root, SUMMARIES), "utf8")).directories["src/lib"]).toEqual(before.directories["src/lib"]);
});

test("prototype-named paths survive and excluded or untracked files never invalidate", () => {
  const { root, runner } = setup();
  for (const path of ["__proto__", "constructor/file", "toString/file", "src/.pi/private", "node_modules/private", ".agent-atlas/private", "nested/node_modules/private"]) put(root, path, "source");
  git(root, "add", "-f", ".");
  const refresh = () => summaries(root, "HEAD", runner, "author", "critic", true);
  expect(refresh()).toMatchObject({ changed: true, directories: 6 });
  const bytes = readFileSync(join(root, SUMMARIES), "utf8");
  const doc = JSON.parse(bytes);
  expect(Object.hasOwn(doc.files, "__proto__")).toBe(true);
  expect(Object.hasOwn(doc.directories, "constructor")).toBe(true);
  expect(doc.files["src/.pi/private"]).toBeUndefined();
  expect(doc.files["nested/node_modules/private"]).toBeUndefined();
  for (const path of ["src/.pi/private", "node_modules/private", ".agent-atlas/private", "nested/node_modules/private", "untracked"]) put(root, path, "changed");
  expect(refresh()).toMatchObject({ changed: false });
  expect(readFileSync(join(root, SUMMARIES), "utf8")).toBe(bytes);
  // A directory named __proto__ must also be an own entry, not a prototype setter.
  rmSync(join(root, "__proto__")); put(root, "__proto__/file", "source"); git(root, "add", "-A", "--", "__proto__");
  refresh();
  expect(Object.hasOwn(JSON.parse(readFileSync(join(root, SUMMARIES), "utf8")).directories, "__proto__")).toBe(true);
  expect(refresh()).toMatchObject({ changed: false });
});

test("check and no-op reject malformed persisted shape, coverage and evidence without calls or writes", () => {
  const { root, runner } = setup();
  summaries(root, "HEAD", runner, "author", "critic", true);
  const original = readFileSync(join(root, SUMMARIES), "utf8");
  const calls = readFileSync(join(root, "calls.jsonl"), "utf8");
  const mutations = [
    (d: any) => { d.extra = true; },
    (d: any) => { d.files = []; },
    (d: any) => { d.directories = []; },
    (d: any) => { d.files["README.md"] = "bad hash"; },
    (d: any) => { d.files[".pi/private"] = "a".repeat(64); },
    (d: any) => { delete d.directories["src"]; d.directories["bogus"] = d.directories["."]; },
    (d: any) => { d.directories["src"].description = ""; },
    (d: any) => { d.directories["src"].extra = true; },
    (d: any) => { d.directories["src"].evidence = []; },
    (d: any) => { d.directories["src"].evidence = ["README.md"]; },
    (d: any) => { d.directories["."].evidence = ["missing"]; },
    (d: any) => { d.directories["."].evidence = ["constructor"]; },
    (d: any) => { d.directories["."].evidence = ["README.md", "README.md"]; },
    (d: any) => { d.directories["."] = null; },
  ];
  for (const mutate of mutations) {
    const doc = JSON.parse(original); mutate(doc);
    const bytes = JSON.stringify(doc); put(root, SUMMARIES, bytes);
    for (const publish of [false, true]) {
      expect(() => summaries(root, "HEAD", runner, "author", "critic", publish)).toThrow();
      expect(readFileSync(join(root, SUMMARIES), "utf8")).toBe(bytes);
      expect(readFileSync(join(root, "calls.jsonl"), "utf8")).toBe(calls);
    }
  }
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
