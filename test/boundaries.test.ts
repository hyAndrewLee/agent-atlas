import { expect, test } from "bun:test";
import { join } from "node:path";
import { build, json, type Rules } from "../src/engine.ts";
import { init } from "../src/install.ts";
import { refresh, load, RULES, EXTENSION } from "../src/store.ts";
import { fixture, put, tree } from "./helpers.ts";
const rules: Rules = { version: 1, domains: [{ name: "all", paths: ["."] }], exclude: [] };
test("nearest config, index resolution, reexports and import-equals are real static edges", () => {
  const root = fixture({
    "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"lib":["lib/index.ts"]}}}',
    "app/tsconfig.json": '{"compilerOptions":{"baseUrl":"..","paths":{"@/*":["lib/*"]}}}',
    "lib/index.ts": "export const x=1;",
    "app/a.cts": 'import x = require("@/index"); export * from "../lib";',
    "root.ts": 'export type {x} from "lib";',
    "app/b.ts": 'export {x} from "@/index";',
  });
  const s = build(root, rules);
  expect(s.adjacency["app/a.cts"]).toEqual(["lib/index.ts"]);
  expect(s.adjacency["root.ts"]).toEqual(["lib/index.ts"]);
  expect(s.adjacency["app/b.ts"]).toEqual(["lib/index.ts"]);
});
test("all non-source files and unsupported dependency constructs are explicitly inventory-only", () => {
  const root = fixture({
    "docs/readme.md": "hello",
    "new.zig": "source",
    "a.ts":
      '/// <reference path="./types.d.ts" />\nconst asset=new URL("./a.svg", import.meta.url);',
    "types.d.ts": "declare const x: string;",
  });
  const s = build(root, rules);
  expect(s.coverage.some((x) => x.includes("docs/readme.md"))).toBe(true);
  expect(s.coverage.some((x) => x.includes("new.zig"))).toBe(true);
  expect(s.coverage.some((x) => x.includes("import.meta"))).toBe(true);
  expect(s.coverage.some((x) => x.includes("triple-slash"))).toBe(true);
  expect(s.adjacency["a.ts"]).toEqual([]);
});
test("unsupported config, syntax, local #imports, assets, excluded targets and alias escapes reject", () => {
  for (const [files, expected] of [
    [
      {
        "tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["../../escape/*"]}}}',
        "a.ts": "export {};",
      },
      "escaping alias",
    ],
    [
      { "tsconfig.json": '{"references":[{"path":"sub"}]}', "a.ts": "export {};" },
      "Unsupported config",
    ],
    [{ "a.ts": 'import x from "#local";' }, "Unresolved local"],
    [{ "a.ts": 'import "./a.css";', "a.css": "body{}" }, "Unresolved local"],
    [{ "a.ts": "export const = ???" }, "Syntax parse error"],
  ] as [Record<string, string>, string][])
    expect(() => build(fixture(files), rules)).toThrow(expected);
  const root = fixture({ "app/a.ts": 'import "../excluded/b";', "excluded/b.ts": "export {};" });
  expect(() =>
    build(root, { version: 1, domains: [{ name: "app", paths: ["app"] }], exclude: ["excluded"] }),
  ).toThrow("excluded/unsupported");
});
test("explicit manual domain addition is accepted, unapproved creation collision is not", async () => {
  const root = fixture({ "a.ts": "export {};" });
  await init(root, rules);
  put(root, "new/package.json", '{"name":"new"}');
  const previous = load(root).current.snapshot;
  expect(() => refresh(root)).toThrow("New package boundary");
  put(
    root,
    RULES,
    json({
      version: 1,
      domains: [
        { name: "a", paths: ["a.ts"] },
        { name: "new", paths: ["new"] },
      ],
      exclude: [],
    }),
  );
  expect(refresh(root).changed).toBe(true);
  expect(load(root).current.snapshot).not.toBe(previous);
  const collision = fixture({
    "app/a.ts": "export {};",
    "packages/a/package.json": '{"name":"a"}',
  });
  expect(() =>
    build(collision, {
      version: 1,
      domains: [{ name: "pkg-a", paths: ["app"] }],
      exclude: [],
      autoPackages: [{ under: "packages", prefix: "pkg-" }],
    }),
  ).toThrow("name conflict");
});
test("explicit exclusions do not invent domains or parse unrelated vendor configs", async () => {
  const root = fixture({
    "app/a.ts": "export {};",
    "vendor/tsconfig.json": '{"extends":"unavailable"}',
  });
  const r = { version: 1, domains: [{ name: "app", paths: ["app"] }], exclude: ["vendor"] };
  await init(root, r);
  put(root, "vendor/new/package.json", "malformed manifest deliberately excluded");
  put(root, "vendor/new/source.ts", "not valid TypeScript!");
  expect(refresh(root).changed).toBe(true);
  expect(load(root).snapshot.nodes).toEqual(["app/a.ts"]);
});
test("CLI ambiguity reports to stdout and leaves a real Git fixture byte-identical", async () => {
  const root = fixture({ "src/a.ts": "export {};" });
  const before = tree(root);
  const p = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), "init", "--root", root],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await new Response(p.stdout).text()).toContain("--config rules.json");
  expect(await p.exited).toBe(1);
  expect(tree(root)).toEqual(before);
});
test("indexing never executes repository scripts, imports or compiler plugins", async () => {
  const root = fixture({
    "package.json": '{"name":"fixture","scripts":{"test":"exit 99"}}',
    "tsconfig.json": '{"compilerOptions":{"plugins":[{"name":"./side.ts"}]}}',
    "a.ts": 'import "./side";',
    "side.ts": 'throw new Error("must not execute");',
  });
  expect((await init(root)).snapshot.adjacency["a.ts"]).toEqual(["side.ts"]);
  expect(tree(root)["canary"]).toBeUndefined();
});
test("unowned Atlas area and interrupted concurrent destination preserve user data", async () => {
  const root = fixture({ "a.ts": "export {};", ".agent-atlas/rules.json": '{"user":true}' });
  const before = tree(root);
  await expect(init(root, rules)).rejects.toThrow("unowned");
  expect(tree(root)).toEqual(before);
  const root2 = fixture({ "a.ts": "export {};" });
  await expect(
    init(root2, rules, {
      afterExtension() {
        put(root2, ".agent-atlas/human.txt", "keep");
      },
    }),
  ).rejects.toThrow("appeared concurrently");
  expect(tree(root2)[".agent-atlas/human.txt"]).toBe(Buffer.from("keep").toString("base64"));
  expect(tree(root2)[EXTENSION]).toBeUndefined();
});
