import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers.ts";
import { check } from "../src/store.ts";

test("packed local package installs with Bun and its bunx binary installs usable navigation", async () => {
  const consumer = fixture({
    "package.json": '{"name":"consumer","private":true}',
    "app.ts": "export const value=1;",
  });
  const archive = join(consumer, "agent-atlas.tgz");
  async function run(args: string[], cwd: string) {
    const p = Bun.spawn([process.execPath, ...args], {
      cwd,
      env: {
        ...process.env,
        BUN_INSTALL_CACHE_DIR: join(consumer, "cache"),
        BUN_INSTALL: join(consumer, "bun-install"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text(),
      err = await new Response(p.stderr).text();
    const code = await p.exited;
    if (code !== 0) throw new Error(`bun ${args.join(" ")} failed (${code}): ${err}\n${out}`);
    return out;
  }
  await run(["pm", "pack", "--ignore-scripts", "--filename", archive], join(import.meta.dir, ".."));
  await run(["add", "--dev", "--ignore-scripts", archive], consumer);
  // Cache/archive are explicit excluded areas: do not index fixture package-manager data.
  const target = fixture({ "package.json": '{"name":"target"}', "a.ts": "export const a=1;" });
  expect(
    await run(["x", "--no-install", "agent-atlas", "init", "--root", target], consumer),
  ).toContain("Installed");
  expect(check(target).fresh).toBe(true);
  expect(
    await run(
      ["x", "--no-install", "agent-atlas", "context", "--root", target, "--seed", "a.ts"],
      consumer,
    ),
  ).toContain("a.ts -> (none)");
}, 60000);
