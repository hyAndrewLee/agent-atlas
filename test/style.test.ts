import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkStyle } from "../scripts/check-style";

const oxlint = resolve(import.meta.dir, "../node_modules/.bin/oxlint");
const oxfmt = resolve(import.meta.dir, "../node_modules/.bin/oxfmt");
const config = resolve(import.meta.dir, "../.oxlintrc.json");

test("Oxlint rejects missing braces and multiple bindings in JS and TS", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-style-"));
  try {
    for (const extension of ["js", "ts"]) {
      const bad = join(directory, `bad.${extension}`);
      const good = join(directory, `good.${extension}`);
      writeFileSync(bad, "const a = 1, b = 2; if (a) console.log(b); else console.log(a);\n");
      writeFileSync(
        good,
        "const a = 1;\nconst b = 2;\nif (a) { console.log(b); } else { console.log(a); }\nfor (let i = 0, j = 1; i < j; i++) { console.log(i); }\n",
      );
      const run = (file: string) => Bun.spawnSync([oxlint, "--config", config, file]);
      const result = run(bad);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toContain("curly");
      expect(result.stdout.toString()).toContain("one-var");
      expect(run(good).exitCode).toBe(0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("syntax-local spacing and safe declaration order", () => {
  for (const extension of ["js", "ts"]) {
    expect(
      checkStyle("function f() { const x = 1; return x; }", `bad.${extension}`),
    ).toContainEqual(expect.stringContaining("blank line"));
    expect(checkStyle("function f() { if (a) {} if (b) {} }", `bad.${extension}`)).toContainEqual(
      expect.stringContaining("blank line"),
    );
    expect(
      checkStyle("function f() { const a = 1; if (a) {} }", `bad.${extension}`),
    ).toContainEqual(expect.stringContaining("blank line"));
    expect(checkStyle("let count = 0; const limit = 5;", `bad.${extension}`)).toContainEqual(
      expect.stringContaining("const before let"),
    );
    expect(checkStyle("let count = next(); const limit = 5;", `good.${extension}`)).toEqual([]);
    expect(
      checkStyle(
        "const limit = 5; let count = 0;\n\nif (limit) {}\n\nif (count) {}\n\nfunction f() { const x = 1;\n\nreturn x; }",
        `good.${extension}`,
      ),
    ).toEqual([]);
  }
});

test("Oxfmt preserves required blank lines", () => {
  const input = "function f() {\n  const x = 1;\n\n  if (x) { return x; }\n\n  return 0;\n}\n";
  const result = Bun.spawnSync([oxfmt, "--stdin-filepath=fixture.ts"], {
    stdin: Buffer.from(input),
  });
  expect(result.exitCode).toBe(0);
  expect(checkStyle(result.stdout.toString())).toEqual([]);
  expect(result.stdout.toString()).toContain("\n\n");
});
