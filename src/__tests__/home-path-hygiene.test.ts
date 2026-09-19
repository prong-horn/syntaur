import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

type Violation = { file: string; line: number; rule: string; excerpt: string };

/** Strip # comments from Python source. */
function stripPyComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('#');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function walkFiles(dir: string, exts: string[], skipTests = false): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (skipTests && entry === '__tests__') continue;
      results.push(...walkFiles(full, exts, skipTests));
    } else if (exts.some((ext) => entry.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function lineExcerpt(source: string, lineNum: number): string {
  const line = source.split('\n')[lineNum - 1] ?? '';
  return line.trim().slice(0, 120);
}

function previousNonEmptyLine(lines: string[], index: number): string | null {
  for (let j = index - 1; j >= 0; j--) {
    if (lines[j].trim()) return lines[j];
  }
  return null;
}

function isCwdWorkspaceMarker(lines: string[], index: number, line: string): boolean {
  if (/['"]\.syntaur['"]\s*,\s*['"]context\.json['"]/.test(line)) return true;
  const prev = previousNonEmptyLine(lines, index)?.trim() ?? '';
  if (/^(?:cwd|ctx\.cwd|opts\.cwd|process\.cwd\(\)|worktree)\s*,?\s*$/.test(prev)) {
    return true;
  }
  return /(?:^|[,(]\s*)(?:cwd|ctx\.cwd|opts\.cwd|process\.cwd\(\)|worktree)\s*,\s*['"]\.syntaur['"]/.test(
    prev ? `${prev}\n${line}` : line,
  );
}

function isSyntaurLiteralExempt(
  text: string,
  rel: string,
  lines?: string[],
  index?: number,
): boolean {
  const isPlatform = rel.startsWith('platforms/hermes/') || rel.startsWith('platforms/pi/');
  if (rel === 'src/utils/paths.ts') return true;
  if (lines !== undefined && index !== undefined && isCwdWorkspaceMarker(lines, index, text)) {
    return true;
  }
  if (/['"]\.syntaur['"]\s*,\s*['"]context\.json['"]/.test(text)) return true;
  if (
    /(?:^|[,(]\s*)(?:cwd|ctx\.cwd|opts\.cwd|process\.cwd\(\)|worktree)\s*,\s*['"]\.syntaur['"]/.test(
      text,
    )
  ) {
    return true;
  }
  if (isPlatform && /SYNTAUR_HOME/.test(text)) return true;
  return false;
}

function isTildeSyntaurExempt(text: string, rel: string): boolean {
  if (rel === 'src/utils/paths.ts') return true;
  if (/~\/\.syntaur\/context\.json/.test(text)) return true;
  const isPlatform = rel.startsWith('platforms/hermes/') || rel.startsWith('platforms/pi/');
  if (isPlatform && /SYNTAUR_HOME/.test(text)) return true;
  return false;
}

function isCommentOnlyLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
}

function isPathResolutionCall(expr: ts.LeftHandSideExpression): boolean {
  if (ts.isIdentifier(expr)) {
    return expr.text === 'resolve' || expr.text === 'join' || expr.text === 'expandHome';
  }
  return false;
}

function nodeContainsTildeSyntaur(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.includes('~/.syntaur');
  }
  if (ts.isTemplateExpression(node)) {
    if (node.head.text.includes('~/.syntaur')) return true;
    return node.templateSpans.some((span) => span.literal.text.includes('~/.syntaur'));
  }
  return false;
}

/** Rule A: no `.syntaur` / `~/.syntaur` literals outside the resolver. */
export function checkRuleA(file: string, source: string, rel: string): Violation[] {
  const violations: Violation[] = [];
  let inBlockComment = false;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const hasDotLiteral = /['"]\.syntaur['"]/.test(line);

    if (!hasDotLiteral) {
      if (line.includes('/*')) inBlockComment = true;
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }

    const codeOnly = inBlockComment ? '' : line.replace(/\/\/.*$/, '');
    if (inBlockComment || !hasDotLiteral || isCommentOnlyLine(codeOnly)) {
      if (line.includes('/*')) inBlockComment = true;
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.includes('/*')) inBlockComment = true;
    if (line.includes('*/')) inBlockComment = false;

    if (!isSyntaurLiteralExempt(codeOnly, rel, lines, i)) {
      violations.push({ file: rel, line: lineNum, rule: 'A', excerpt: lineExcerpt(source, lineNum) });
    }
  }

  const scriptKind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKind);

  function visitPathStrings(node: ts.Node): void {
    if (ts.isCallExpression(node) && isPathResolutionCall(node.expression)) {
      for (const arg of node.arguments) {
        if (!nodeContainsTildeSyntaur(arg)) continue;
        const text = ts.isStringLiteral(arg) ? arg.text : arg.getText(sourceFile);
        if (isTildeSyntaurExempt(text, rel)) continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(arg.getStart());
        violations.push({
          file: rel,
          line: line + 1,
          rule: 'A',
          excerpt: lineExcerpt(source, line + 1),
        });
      }
    }
    ts.forEachChild(node, visitPathStrings);
  }

  if (rel !== 'src/utils/paths.ts') {
    visitPathStrings(sourceFile);
  }

  return violations;
}

/** Rule B: no home lookups outside the allowlist (TypeScript under src/ only). */
const RULE_B_ALLOWLIST: Record<string, string> = {
  'src/utils/paths.ts': 'resolver',
  'src/utils/session-id.ts': 'Claude sessions home',
  'src/utils/install.ts': 'legacy install probe paths',
  'src/utils/doctor/checks/skills.ts': 'Claude/Codex skills dirs',
  'src/utils/doctor/checks/hooks.ts': 'Claude settings paths',
  'src/commands/statusline-install.ts': 'statusline install',
  'src/commands/hooks.ts': 'hooks install paths',
  'src/commands/update.ts': 'update paths',
  'src/usage/cwd-extractor.ts': 'cwd extraction',
  'src/chat/chat-cwd.ts': 'chat cwd',
};

type HomeLookupContext = {
  homedirNames: Set<string>;
  osNamespaceNames: Set<string>;
};

function moduleSpecifierText(spec: ts.Expression): string {
  return ts.isStringLiteral(spec) ? spec.text : '';
}

function isOsModuleSpecifier(spec: ts.Expression): boolean {
  const text = moduleSpecifierText(spec);
  return text === 'os' || text === 'node:os';
}

function buildHomeLookupContext(sourceFile: ts.SourceFile): HomeLookupContext {
  const homedirNames = new Set<string>();
  const osNamespaceNames = new Set<string>();

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause && stmt.moduleSpecifier) {
      if (!isOsModuleSpecifier(stmt.moduleSpecifier)) continue;
      if (stmt.importClause.name) {
        osNamespaceNames.add(stmt.importClause.name.text);
      }
      const bindings = stmt.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const imported = el.propertyName?.text ?? el.name.text;
          if (imported === 'homedir') homedirNames.add(el.name.text);
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) {
        osNamespaceNames.add(bindings.name.text);
      }
    }

    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (ts.isIdentifier(decl.name)) {
        if (ts.isCallExpression(decl.initializer) && isRequireOsCall(decl.initializer)) {
          osNamespaceNames.add(decl.name.text);
        }
        continue;
      }
      if (
        ts.isObjectBindingPattern(decl.name) &&
        ts.isCallExpression(decl.initializer) &&
        isRequireOsCall(decl.initializer)
      ) {
        for (const el of decl.name.elements) {
          if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
          const imported = el.propertyName && ts.isIdentifier(el.propertyName)
            ? el.propertyName.text
            : el.name.text;
          if (imported === 'homedir') homedirNames.add(el.name.text);
        }
      }
    }
  }

  return { homedirNames, osNamespaceNames };
}

function isRequireOsCall(node: ts.CallExpression): boolean {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') return false;
  const arg = node.arguments[0];
  return arg !== undefined && isOsModuleSpecifier(arg);
}

function isProcessEnvHome(node: ts.Node): boolean {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    ts.isIdentifier(node.expression.name) &&
    node.expression.name.text === 'env' &&
    ts.isIdentifier(node.name) &&
    (node.name.text === 'HOME' || node.name.text === 'USERPROFILE')
  ) {
    return true;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    ts.isIdentifier(node.expression.name) &&
    node.expression.name.text === 'env' &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression) &&
    (node.argumentExpression.text === 'HOME' || node.argumentExpression.text === 'USERPROFILE')
  ) {
    return true;
  }
  return false;
}

function isRuleBHomeLookup(node: ts.Node, ctx: HomeLookupContext): boolean {
  if (isProcessEnvHome(node)) return true;

  if (ts.isCallExpression(node)) {
    const expr = node.expression;
    if (ts.isIdentifier(expr) && (expr.text === 'homedir' || ctx.homedirNames.has(expr.text))) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.name) &&
      expr.name.text === 'homedir'
    ) {
      if (ts.isIdentifier(expr.expression) && expr.expression.text === 'os') return true;
      if (ts.isIdentifier(expr.expression) && ctx.osNamespaceNames.has(expr.expression.text)) {
        return true;
      }
      if (ts.isCallExpression(expr.expression) && isRequireOsCall(expr.expression)) {
        return true;
      }
    }
  }
  return false;
}

export function checkRuleB(file: string, source: string, rel: string): Violation[] {
  if (!rel.startsWith('src/') || rel.includes('/__tests__/')) return [];
  if (RULE_B_ALLOWLIST[rel]) return [];

  const scriptKind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKind);
  const ctx = buildHomeLookupContext(sourceFile);
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (isRuleBHomeLookup(node, ctx)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      violations.push({
        file: rel,
        line: line + 1,
        rule: 'B',
        excerpt: lineExcerpt(source, line + 1),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

function pathsExportedFunctions(): string[] {
  const pathsSource = readFileSync(join(REPO_ROOT, 'src/utils/paths.ts'), 'utf-8');
  const names: string[] = [];
  const re = /^export function (\w+)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pathsSource)) !== null) {
    names.push(m[1]);
  }
  return names;
}

const RESOLUTION_CALLS = ['syntaurRoot', 'homedir', 'expandHome'];

function isForbiddenCall(node: ts.CallExpression, forbidden: Set<string>): boolean {
  const expr = node.expression;
  if (ts.isIdentifier(expr) && forbidden.has(expr.text)) return true;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.name) &&
    expr.name.text === 'homedir' &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'os' &&
    forbidden.has('homedir')
  ) {
    return true;
  }
  return false;
}

function isIifeCallee(fn: ts.FunctionLike): boolean {
  let expr: ts.Node = fn;
  let parent: ts.Node | undefined = fn.parent;
  while (parent) {
    if (ts.isCallExpression(parent) && parent.expression === expr) return true;
    if (ts.isParenthesizedExpression(parent) && parent.expression === expr) {
      expr = parent;
      parent = parent.parent;
      continue;
    }
    break;
  }
  return false;
}

function statementHasForbiddenResolution(stmt: ts.Statement, forbidden: Set<string>): boolean {
  let found = false;

  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isFunctionLike(n)) {
      if (isIifeCallee(n)) ts.forEachChild(n, visit);
      return;
    }
    if (ts.isCallExpression(n) && isForbiddenCall(n, forbidden)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  }

  visit(stmt);
  return found;
}

function isSkippedTopLevelStatement(stmt: ts.Statement): boolean {
  return (
    ts.isFunctionDeclaration(stmt) ||
    ts.isClassDeclaration(stmt) ||
    ts.isImportDeclaration(stmt) ||
    ts.isImportEqualsDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt) ||
    ts.isModuleDeclaration(stmt) ||
    ts.isExportDeclaration(stmt)
  );
}

/** Rule C: no module-scope path resolution (TypeScript). */
export function checkRuleC(file: string, source: string, rel: string): Violation[] {
  const scriptKind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKind);
  const forbidden = new Set([...RESOLUTION_CALLS, ...pathsExportedFunctions()]);
  const violations: Violation[] = [];

  for (const stmt of sourceFile.statements) {
    if (isSkippedTopLevelStatement(stmt)) continue;
    if (!statementHasForbiddenResolution(stmt, forbidden)) continue;
    const start = stmt.getStart();
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    violations.push({
      file: rel,
      line: line + 1,
      rule: 'C',
      excerpt: lineExcerpt(source, line + 1),
    });
  }

  return violations;
}

function scanAll(): Violation[] {
  const violations: Violation[] = [];

  const tsFiles = walkFiles(join(REPO_ROOT, 'src'), ['.ts', '.tsx'], true);
  for (const file of tsFiles) {
    const rel = relative(REPO_ROOT, file);
    const raw = readFileSync(file, 'utf-8');
    violations.push(...checkRuleA(file, raw, rel));
    violations.push(...checkRuleB(file, raw, rel));
    violations.push(...checkRuleC(file, raw, rel));
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

describe('home path hygiene', () => {
  it('has no Syntaur-home path bypasses', () => {
    const violations = scanAll();
    if (violations.length > 0) {
      const report = violations
        .map((v) => `${v.file}:${v.line}: rule ${v.rule} — ${v.excerpt}`)
        .join('\n');
      expect.fail(`Home path hygiene violations:\n${report}`);
    }
    expect(violations).toEqual([]);
  });

  describe('rule A fixtures', () => {
    it('flags ~/.syntaur passed to resolve()', () => {
      const src = `import { resolve } from 'node:path';\nconst p = resolve('~/.syntaur/db');\n`;
      expect(checkRuleA('x.ts', src, 'src/leak.ts').some((v) => v.rule === 'A')).toBe(true);
    });

    it('exempts multi-line resolve(cwd, .syntaur, context.json)', () => {
      const src = [
        'const p = resolve(',
        '  cwd,',
        "  '.syntaur',",
        "  'context.json',",
        ');',
      ].join('\n');
      expect(checkRuleA('x.ts', src, 'src/ws.ts')).toEqual([]);
    });
  });

  describe('rule B fixtures', () => {
    const rel = 'src/fixture.ts';

    it('flags process.env["HOME"]', () => {
      const src = `const x = process.env['HOME'];\n`;
      expect(checkRuleB('x.ts', src, rel).length).toBeGreaterThan(0);
    });

    it('flags homedir import aliases', () => {
      const src = `import { homedir as getHome } from 'node:os';\nconst x = getHome();\n`;
      expect(checkRuleB('x.ts', src, rel).length).toBeGreaterThan(0);
    });

    it('flags namespace import homedir', () => {
      const src = `import * as nodeOs from 'node:os';\nconst x = nodeOs.homedir();\n`;
      expect(checkRuleB('x.ts', src, rel).length).toBeGreaterThan(0);
    });

    it('flags require("os").homedir()', () => {
      const src = `const x = require('os').homedir();\n`;
      expect(checkRuleB('x.ts', src, rel).length).toBeGreaterThan(0);
    });
  });

  describe('rule C fixtures', () => {
    const rel = 'src/fixture.ts';

    it('flags top-level mkdirSync(resolve(syntaurRoot(), ...))', () => {
      const src = `import { mkdirSync } from 'node:fs';\nimport { resolve } from 'node:path';\nimport { syntaurRoot } from './paths.js';\nmkdirSync(resolve(syntaurRoot(), 'runtime'));\n`;
      expect(checkRuleC('x.ts', src, rel).length).toBeGreaterThan(0);
    });

    it('flags export default resolve(syntaurRoot(), ...)', () => {
      const src = `import { resolve } from 'node:path';\nimport { syntaurRoot } from './paths.js';\nexport default resolve(syntaurRoot(), 'x');\n`;
      expect(checkRuleC('x.ts', src, rel).length).toBeGreaterThan(0);
    });

    it('flags IIFE that calls syntaurRoot at module scope', () => {
      const src = `import { syntaurRoot } from './paths.js';\nconst STATE = (() => syntaurRoot())();\n`;
      expect(checkRuleC('x.ts', src, rel).length).toBeGreaterThan(0);
    });

    it('allows Object.defineProperty getter for defaultProjectDir', () => {
      const src = [
        "import { defaultProjectDir } from './paths.js';",
        'const DEFAULT_CONFIG = { version: "2.0", defaultProjectDir: "" };',
        "Object.defineProperty(DEFAULT_CONFIG, 'defaultProjectDir', {",
        '  get() { return defaultProjectDir(); },',
        '});',
      ].join('\n');
      expect(checkRuleC('x.ts', src, rel)).toEqual([]);
    });
  });
});
