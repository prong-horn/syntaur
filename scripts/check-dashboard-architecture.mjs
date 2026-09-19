#!/usr/bin/env node
/**
 * SV-12 dashboard architecture gate: page allowlist/LOC, sidebar families,
 * and no raw global fetch outside data/client.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = process.env.SYNTAUR_ARCH_CHECK_ROOT ?? join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DASHBOARD_SRC = join(ROOT, 'dashboard', 'src');
const PAGES_DIR = join(DASHBOARD_SRC, 'pages');
const CLIENT_FILE = join(DASHBOARD_SRC, 'data', 'client.ts');
const APPSHELL_FILE = join(DASHBOARD_SRC, 'components', 'AppShell.tsx');

const ALLOWED_PAGES = new Set([
  'NeedsMePage.tsx',
  'BoardPage.tsx',
  'TicketPage.tsx',
  'SessionsPage.tsx',
  'LibraryPage.tsx',
  'SettingsPage.tsx',
]);

const MAX_PAGE_LINES = 500;

const STATEFUL_FETCH_MODULES = new Set([
  join(DASHBOARD_SRC, 'lib', 'chat-api.ts'),
  join(DASHBOARD_SRC, 'lib', 'stage-dispatch-controller.ts'),
  join(DASHBOARD_SRC, 'lib', 'stage-dispatch-runtime.ts'),
]);

const SKIP_DIR_NAMES = new Set(['__tests__', 'node_modules', 'dist']);
const SKIP_FILE_RE = /\.(test|spec)\.[tj]sx?$|\.d\.ts$/;

const errors = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !SKIP_FILE_RE.test(name)) out.push(abs);
  }
  return out;
}

function lineCount(file) {
  return readFileSync(file, 'utf8').split('\n').length;
}

function checkPages() {
  for (const name of readdirSync(PAGES_DIR)) {
    if (!name.endsWith('.tsx')) continue;
    if (name.startsWith('__')) continue;
    const abs = join(PAGES_DIR, name);
    if (!ALLOWED_PAGES.has(name)) {
      errors.push(`pages/${name}: only six canonical page modules are allowed`);
      continue;
    }
    const lines = lineCount(abs);
    if (lines > MAX_PAGE_LINES) {
      errors.push(`pages/${name}: ${lines} lines exceeds ${MAX_PAGE_LINES} LOC limit`);
    }
  }
  for (const required of ALLOWED_PAGES) {
    if (!readdirSync(PAGES_DIR).includes(required)) {
      errors.push(`pages/${required}: missing required canonical page module`);
    }
  }
}

function checkSidebarFamilies() {
  const source = readFileSync(APPSHELL_FILE, 'utf8');
  const required = ['/inbox', '/board', '/sessions', '/library/playbooks', '/settings'];
  for (const path of required) {
    if (!source.includes(`'${path}'`) && !source.includes(`"${path}"`)) {
      errors.push(`AppShell.tsx: missing sidebar nav item for ${path}`);
    }
  }
  if (/\bto:\s*['"]\/t\//.test(source)) {
    errors.push('AppShell.tsx: ticket route must not appear as a primary sidebar destination');
  }
}

function isTypePosition(node, sourceFile) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isTypeReferenceNode(cur) ||
      cur.kind === ts.SyntaxKind.TypeQuery ||
      ts.isTypeAliasDeclaration(cur) ||
      ts.isInterfaceDeclaration(cur) ||
      ts.isMethodSignature(cur) ||
      ts.isPropertySignature(cur) ||
      ts.isFunctionTypeNode(cur)
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function identifierIsFetch(name) {
  return name === 'fetch' || name === 'window' || name === 'globalThis' || name === 'self';
}

function checkFetchUsage(file) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  function report(node, message) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    errors.push(`${rel}:${line + 1}: ${message}`);
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === 'fetch' && !isTypePosition(node, sourceFile)) {
        if (file !== CLIENT_FILE && !STATEFUL_FETCH_MODULES.has(file)) {
          report(node, 'raw fetch() call');
        }
      }
      if (ts.isPropertyAccessExpression(expr)) {
        const name = expr.name.text;
        if (name === 'fetch' && identifierIsFetch(expr.expression.getText(sourceFile)) && !isTypePosition(node, sourceFile)) {
          if (file !== CLIENT_FILE && !STATEFUL_FETCH_MODULES.has(file)) {
            report(node, 'raw property fetch call');
          }
        }
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const id = node.expression.text;
      if (id === 'XMLHttpRequest' || id === 'EventSource') {
        report(node, `forbidden transport ${id}`);
      }
    }

    if (ts.isIdentifier(node) && node.text === 'fetch' && !isTypePosition(node, sourceFile)) {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
        report(node, 'fetch identifier binding');
      }
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
        report(node, 'fetch default assignment');
      }
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        report(node, 'fetch nullish fallback');
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function main() {
  checkPages();
  checkSidebarFamilies();
  for (const file of walk(DASHBOARD_SRC)) {
    checkFetchUsage(file);
  }
  if (errors.length) {
    console.error('dashboard architecture check failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }
  console.log('dashboard architecture check passed');
}

main();
