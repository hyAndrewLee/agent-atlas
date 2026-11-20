import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers.ts";
import { build, context, parseRules, propose, inventory, type Rules } from "../src/engine.ts";
const rules: Rules = { version: 1, domains: [{ name: "app", paths: ["."] }], exclude: [] };
test("AST graph: static imports/exports, cycles, aliases, isolated nodes, JS extension substitution", () => {
  const root = fixture({
    "package.json": '{"name":"fixture"}',
    "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
    "src/a.ts": 'import {b} from "@/b"; export {b};',
    "src/b.ts": 'export {a} from "./a.js"; export const b=1;',
    "alone.js": "export const x=1;",
    "types.ts": 'type T = import("./src/b").X;',
  });
  const s = build(root, rules);
  expect(s.nodes).toEqual(["alone.js", "src/a.ts", "src/b.ts", "types.ts"]);
  expect(s.adjacency["src/a.ts"]).toEqual(["src/b.ts"]);
  expect(s.adjacency["src/b.ts"]).toEqual(["src/a.ts"]);
  expect(s.adjacency["types.ts"]).toEqual(["src/b.ts"]);
  expect(context(s, { seeds: ["src/a.ts"] })).toContain("src/b.ts");
  expect(() => context(s, {})).toThrow("Select");
  expect(build(root, rules)).toEqual(s);
});
test("external packages distinct from local errors and unsupported constructs reported", () => {
  const root = fixture({
    "a.ts": 'import x from "external"; const y=import("./lazy"); const z=require(name);',
    "other.py": "print(1)",
  });
  const s = build(root, rules);
  expect(s.external).toEqual([{ from: "a.ts", specifier: "external" }]);
  expect(s.coverage.length).toBe(3);
  writeFileSync(join(root, "a.ts"), 'import "./missing";');
  expect(() => build(root, rules)).toThrow("Unresolved local");
});
test("explicit ownership and package-creation authorization", () => {
  const root = fixture({ "app/a.ts": "export {};" });
  const r: Rules = {
    version: 1,
    domains: [{ name: "app", paths: ["app"] }],
    exclude: [],
    autoPackages: [{ under: "packages", prefix: "pkg-" }],
  };
  const s = build(root, r);
  mkdirSync(join(root, "packages/new"), { recursive: true });
  writeFileSync(join(root, "packages/new/package.json"), '{"name":"new"}');
  writeFileSync(join(root, "packages/new/b.ts"), "export {};");
  expect(build(root, r, s).domains.map((d) => d.name)).toEqual(["app", "pkg-new"]);
  writeFileSync(join(root, "unknown.ts"), "");
  expect(() => build(root, r, s)).toThrow("Unassigned");
  expect(() => parseRules({ ...rules, exclude: ["src"] })).toThrow("Overlapping");
});
test("initial ambiguity, new nested package and inherited resolver configs stop safely", () => {
  const root = fixture({ "src/a.ts": "export {};" });
  expect(() => propose(inventory(root))).toThrow("Zero files written");
  const s = build(root, rules);
  mkdirSync(join(root, "src/nested"));
  writeFileSync(join(root, "src/nested/package.json"), "{}");
  expect(() => build(root, rules, s)).toThrow("New package boundary");
  writeFileSync(join(root, "tsconfig.json"), '{"extends":"other"}');
  expect(() => build(root, rules)).toThrow("Unsupported config");
});
test("symlink, traversal and escaping resolver rejection", () => {
  const root = fixture({ "a.ts": "export {};" });
  expect(() => parseRules({ ...rules, domains: [{ name: "x", paths: ["../escape"] }] })).toThrow(
    "Unsafe",
  );
  symlinkSync("/etc/passwd", join(root, "link"));
  expect(() => build(root, rules)).toThrow("Symlink");
  rmSync(join(root, "link"));
  writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"baseUrl":".."}}');
  expect(() => build(root, rules)).toThrow("escapes");
});
test("CLI subprocess navigation is real and read-only", async () => {
  const root = fixture({ "package.json": '{"name":"fixture"}', "a.ts": "export {};" });
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../src/cli.ts"),
      "context",
      "--root",
      root,
      "--domain",
      "root",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await new Response(proc.stdout).text()).toContain("a.ts -> (none)");
  expect(await proc.exited).toBe(0);
  expect([...inventory(root).keys()]).toEqual(["a.ts", "package.json"]);
});
