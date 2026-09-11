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

function isSyntaurLiteralExempt(line: string, rel: string): boolean {
  const isPlatform = rel.startsWith('platforms/hermes/') || rel.startsWith('platforms/pi/');
  if (rel === 'src/utils/paths.ts') return true;
  if (/['"]\.syntaur['"]\s*,\s*['"]context\.json['"]/.test(line)) return true;
  if (
    /(?:^|[,(]\s*)(?:cwd|ctx\.cwd|opts\.cwd|process\.cwd\(\)|worktreePath)\s*,\s*['"]\.syntaur['"]/.test(
      line,
    )
  ) {
    return true;
  }
  if (isPlatform && /SYNTAUR_HOME/.test(line)) return true;
  return false;
}

/** Rule A: no `.syntaur` literal outside the resolver. */
function checkRuleA(file: string, source: string, rel: string): Violation[] {
  const violations: Violation[] = [];
  let inBlockComment = false;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    if (!/['"]\.syntaur['"]/.test(line)) {
      if (line.includes('/*')) inBlockComment = true;
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }

    const codeOnly = inBlockComment ? '' : line.replace(/\/\/.*$/, '');
    if (inBlockComment || !/['"]\.syntaur['"]/.test(codeOnly)) {
      if (line.includes('/*')) inBlockComment = true;
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.includes('/*')) inBlockComment = true;
    if (line.includes('*/')) inBlockComment = false;

    if (isSyntaurLiteralExempt(codeOnly, rel)) continue;

    violations.push({
      file: rel,
      line: lineNum,
      rule: 'A',
      excerpt: lineExcerpt(source, lineNum),
    });
  }
  return violations;
}

/** Rule B: no home lookups outside the allowlist (TypeScript under src/ only). */
const RULE_B_ALLOWLIST: Record<string, string> = {
  'src/utils/paths.ts': 'resolver',
  'src/utils/session-id.ts': 'Claude sessions home',
  'src/schedules/launchd.ts': 'LaunchAgents plist',
  'src/targets/registry.ts': 'agent install targets',
  'src/utils/install.ts': 'agent install paths',
  'src/utils/install-skills.ts': 'skill install paths',
  'src/utils/plugin-state.ts': 'plugin state paths',
  'src/utils/doctor/checks/integrations.ts': 'integration paths',
  'src/utils/doctor/checks/skills.ts': 'Claude/Codex skills dirs',
  'src/commands/install-statusline.ts': 'statusline install',
  'src/commands/update.ts': 'update paths',
  'src/usage/cwd-extractor.ts': 'cwd extraction',
  'src/chat/chat-cwd.ts': 'chat cwd',
};

function isRuleBHomeLookup(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const expr = node.expression;
    if (ts.isIdentifier(expr) && expr.text === 'homedir') return true;
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.name) &&
      expr.name.text === 'homedir' &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === 'os'
    ) {
      return true;
    }
  }
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
  return false;
}

function checkRuleB(file: string, source: string, rel: string): Violation[] {
  if (!rel.startsWith('src/') || rel.includes('/__tests__/')) return [];
  if (RULE_B_ALLOWLIST[rel]) return [];

  const scriptKind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKind);
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (isRuleBHomeLookup(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      const lineNum = line + 1;
      violations.push({
        file: rel,
        line: lineNum,
        rule: 'B',
        excerpt: lineExcerpt(source, lineNum),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

/** Read exported function names from src/utils/paths.ts at test time. */
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
  if (ts.isIdentifier(expr)) {
    return forbidden.has(expr.text);
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.name) &&
    expr.name.text === 'homedir' &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'os'
  ) {
    return true;
  }
  return false;
}

function containsForbiddenCall(node: ts.Node, forbidden: Set<string>): boolean {
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n) && isForbiddenCall(n, forbidden)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

/** Rule C: no module-scope path resolution (TypeScript). */
function checkRuleC(file: string, source: string, rel: string): Violation[] {
  const scriptKind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKind);
  const forbidden = new Set([...RESOLUTION_CALLS, ...pathsExportedFunctions()]);
  const violations: Violation[] = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !containsForbiddenCall(decl.initializer, forbidden)) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(decl.initializer.getStart());
      const lineNum = line + 1;
      violations.push({
        file: rel,
        line: lineNum,
        rule: 'C',
        excerpt: lineExcerpt(source, lineNum),
      });
    }
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

  const pyFiles = walkFiles(join(REPO_ROOT, 'platforms/hermes/plugins/syntaur'), ['.py']);
  for (const file of pyFiles) {
    const rel = relative(REPO_ROOT, file);
    const raw = readFileSync(file, 'utf-8');
    violations.push(...checkRuleA(file, stripPyComments(raw), rel));
  }

  const piFiles = walkFiles(join(REPO_ROOT, 'platforms/pi/extensions/syntaur'), ['.ts']);
  for (const file of piFiles) {
    const rel = relative(REPO_ROOT, file);
    const raw = readFileSync(file, 'utf-8');
    violations.push(...checkRuleA(file, raw, rel));
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
});
