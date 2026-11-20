import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Only syntax-local rules live here. Oxlint owns braces and declaration cardinality.
export function checkStyle(source: string, path = "fixture.ts"): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const line = (position: number) => file.getLineAndCharacterOfPosition(position).line;
  const report = (node: ts.Node, message: string) => {
    errors.push(`${path}:${line(node.getStart(file)) + 1}: ${message}`);
  };
  const blankBefore = (previous: ts.Node, current: ts.Node): boolean => {
    const gap = source.slice(previous.getEnd(), current.getStart(file));
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      gap,
    );
    const visible = gap.split("");
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        visible.fill("#", scanner.getTokenPos(), scanner.getTextPos());
      }
    }
    return /(?:\r\n|\r|\n)[ \t]*(?=\r\n|\r|\n)/.test(visible.join(""));
  };
  const literal = (node: ts.Expression | undefined): boolean =>
    !!node &&
    (ts.isLiteralExpression(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword);
  const independent = (node: ts.Statement): boolean =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.length === 1 &&
    ts.isIdentifier(node.declarationList.declarations[0]!.name) &&
    literal(node.declarationList.declarations[0]!.initializer);

  const visit = (node: ts.Node) => {
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const statements = node.statements;
      for (let i = 1; i < statements.length; i++) {
        const previous = statements[i - 1]!;
        const current = statements[i]!;
        if (
          (ts.isReturnStatement(current) ||
            (ts.isIfStatement(previous) && ts.isIfStatement(current)) ||
            (ts.isVariableStatement(previous) && ts.isIfStatement(current)) ||
            (ts.isIfStatement(previous) && ts.isVariableStatement(current))) &&
          !blankBefore(previous, current)
        ) {
          report(current, "blank line required between statements");
        }
        // Reordering expressions can change behavior; require const-first only for
        // adjacent, independent primitive literal bindings. Other groups retain order.
        if (
          independent(previous) &&
          independent(current) &&
          ts.isVariableStatement(previous) &&
          ts.isVariableStatement(current) &&
          (previous.declarationList.flags & ts.NodeFlags.Let) !== 0 &&
          (current.declarationList.flags & ts.NodeFlags.Const) !== 0
        ) {
          report(current, "put independent const before let");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}

if (import.meta.main) {
  const errors: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        errors.push(...checkStyle(readFileSync(path, "utf8"), path));
      }
    }
  };
  for (const directory of ["src", "test"]) {
    walk(directory);
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
