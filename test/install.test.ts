import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { init, runtimeBundle } from "../src/install.ts";
import { check, load, lock, refresh, RULES, SKILL, EXTENSION } from "../src/store.ts";
import { json, type Rules } from "../src/engine.ts";
import { fixture, put, tree } from "./helpers.ts";
const r: Rules = { version: 1, domains: [{ name: "app", paths: ["app"] }, { name: "metadata", paths: ["package.json", "README.md"] }], exclude: [], autoPackages: [{ under: "packages", prefix: "pkg-" }] };
const files = { "app/a.ts": 'export const a=1;', "package.json": '{"name":"fixture"}', "README.md": "human documentation" };
// Build once; this is the exact self-contained payload used by real init.
const bundle = await runtimeBundle();
test("successful install preserves instructions/config and idempotence verifies ownership", async () => {
  const root = fixture({ ...files, "AGENTS.md": "human instructions", ".pi/settings.json": '{"theme":"human"}', ".pi/extensions/human.ts": "// human" });
  const rules = { ...r, domains: [...r.domains, { name: "instructions", paths: ["AGENTS.md"] }] };
  expect((await init(root, rules, { bundle })).changed).toBe(true);
  expect(check(root).fresh).toBe(true);
  const before = tree(root);
  expect((await init(root, rules)).changed).toBe(false);
  expect(tree(root)).toEqual(before);
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("human instructions");
  expect(readFileSync(join(root, ".pi/settings.json"), "utf8")).toContain("human");
  put(root, SKILL, "human edited generated skill"); const edited = tree(root);
  await expect(init(root)).rejects.toThrow("Edited generated");
  expect(() => refresh(root)).toThrow("Edited generated"); expect(tree(root)).toEqual(edited);
});
test("valid new nodes and preapproved domains refresh through an atomic pointer, rules untouched", async () => {
  const root = fixture(files); await init(root, r, { bundle });
  const rulesBytes = readFileSync(join(root, RULES), "utf8"), pointer = load(root).current.snapshot;
  put(root, "app/b.ts", 'export {a} from "./a";');
  expect(check(root).fresh).toBe(false);
  const beforeCheck = tree(root); check(root); expect(tree(root)).toEqual(beforeCheck);
  expect(refresh(root).changed).toBe(true); expect(load(root).current.snapshot).not.toBe(pointer);
  put(root, "packages/new/package.json", '{"name":"new"}'); put(root, "packages/new/index.ts", "export {};");
  expect(refresh(root).snapshot.domains.map(d => d.name)).toContain("pkg-new");
  expect(readFileSync(join(root, RULES), "utf8")).toBe(rulesBytes);
});
test("ambiguous files, new package boundaries and conflicting human rules yield zero navigation writes", async () => {
  const root = fixture(files); await init(root, r, { bundle });
  put(root, "unknown/new.ts", "export {};"); let before = tree(root);
  expect(() => refresh(root)).toThrow("Unassigned"); expect(tree(root)).toEqual(before);
  const root2 = fixture(files); await init(root2, r, { bundle }); put(root2, "app/nested/package.json", "{}"); before = tree(root2);
  expect(() => refresh(root2)).toThrow("New package boundary"); expect(tree(root2)).toEqual(before);
  const root3 = fixture(files); await init(root3, r, { bundle });
  put(root3, RULES, json({ ...r, exclude: ["app/a.ts"] })); before = tree(root3);
  expect(() => refresh(root3)).toThrow("Overlapping"); expect(tree(root3)).toEqual(before);
});
test("install ambiguity/conflicts and injected publish failure leave no partial installation", async () => {
  const root = fixture({ "a.ts": "export {};" }); let before = tree(root);
  await expect(init(root, undefined, { bundle })).rejects.toThrow("Zero files written"); expect(tree(root)).toEqual(before);
  const root2 = fixture({ ...files, [EXTENSION]: "// user extension" }); before = tree(root2);
  await expect(init(root2, r, { bundle })).rejects.toThrow("Existing user"); expect(tree(root2)).toEqual(before);
  const root3 = fixture(files); before = tree(root3);
  await expect(init(root3, r, { bundle, afterExtension() { throw new Error("simulated disk failure"); } })).rejects.toThrow("simulated disk failure");
  expect(tree(root3)).toEqual(before);
});
test("stale sources and artifacts never activate a mixed snapshot; concurrent writer refuses", async () => {
  const root = fixture(files); await init(root, r, { bundle });
  put(root, "app/a.ts", "export const a=2;"); const current = load(root).current;
  expect(() => refresh(root, () => put(root, "app/a.ts", "export const a=3;"))).toThrow("Sources or rules changed");
  expect(load(root).current).toEqual(current);
  expect(() => lock(root, () => refresh(root))).toThrow("Another Atlas writer");
  expect(refresh(root).changed).toBe(true);
  put(root, "app/a.ts", "export const a=4;");
  expect(() => refresh(root, () => put(root, EXTENSION, "// edited"))).toThrow("Edited generated");
  const root2 = fixture(files); const before = tree(root2);
  await expect(init(root2, r, { bundle, beforePublish() { put(root2, "app/a.ts", "export const changed=1;"); } })).rejects.toThrow("Sources changed");
  expect(Object.keys(tree(root2))).toEqual(Object.keys(before));
});
test("installation refuses symlink destination ancestors without following them", async () => {
  const root = fixture(files), outside = fixture({ "keep": "safe" });
  symlinkSync(outside, join(root, ".pi")); const before = tree(outside);
  await expect(init(root, r, { bundle })).rejects.toThrow("Symlink"); expect(tree(outside)).toEqual(before);
});
test("installed bundle runs in plain Node with no dependencies in consuming repository", async () => {
  const root = fixture(files); await init(root, r, { bundle });
  const script = `import atlas from ${JSON.stringify(join(root, ".agent-atlas/runtime.mjs"))}; const handlers={}; atlas({on(n,f){handlers[n]=f},registerCommand(){},sendMessage(){}}, ${JSON.stringify(root)}); const r=handlers.before_agent_start({}, {cwd:${JSON.stringify(root)}}); if(!r.message.content.includes('Domain map')) process.exit(2); console.log('adapter loaded');`;
  const p = Bun.spawn(["node", "--input-type=module", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(p.stderr).text(); expect(stderr).toBe("");
  expect(await p.exited).toBe(0); expect(await new Response(p.stdout).text()).toContain("adapter loaded");
});
