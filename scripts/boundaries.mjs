import { readdirSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function owner(path) {
  const parts = path.split('/');
  return ['apps', 'services', 'packages'].includes(parts[0]) ? parts.slice(0, 2).join('/') : null;
}

export function findBoundaryViolations(files, packages) {
  const violations = [];
  for (const [file, content] of Object.entries(files)) {
    const source = owner(file);
    const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    function inspect(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        specifier = node.moduleSpecifier;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(ast) === 'require')
      )
        specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) {
        const value = specifier.text;
        const entry = Object.hasOwn(packages, value)
          ? value
          : Object.keys(packages).find((name) => value.startsWith(`${name}/`));
        const target = value.startsWith('.')
          ? owner(posix.normalize(posix.join(dirname(file).replaceAll('\\', '/'), value)))
          : entry && packages[entry];
        if (
          target &&
          source !== target &&
          (target.startsWith('apps/') || target.startsWith('services/') || value.startsWith('.'))
        ) {
          violations.push(`${file}: forbidden implementation import ${value}`);
        } else if (entry && value !== entry) {
          violations.push(`${file}: use the public package entrypoint for ${value}`);
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
  }
  return violations.sort();
}

function collect(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.next', 'generated'].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) collect(path, files);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files[path] = readFileSync(path, 'utf8');
  }
}

export function checkBoundaries() {
  const packages = {};
  const files = {};
  for (const group of ['apps', 'services', 'packages']) {
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${group}/${entry.name}`;
      const manifest = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'));
      packages[manifest.name] = directory;
      for (const [path, target] of Object.entries(manifest.exports ?? {})) {
        if (target && path.startsWith('./') && !path.includes('*'))
          packages[manifest.name + path.slice(1)] = directory;
      }
      collect(directory, files);
    }
  }
  const violations = findBoundaryViolations(files, packages);
  if (violations.length) throw new Error(violations.join('\n'));
  console.log(`Workspace boundaries passed (${Object.keys(files).length} files).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  checkBoundaries();
