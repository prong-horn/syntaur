import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractFrontmatter, getField } from '../dashboard/parser.js';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import { bundlesDir, bundlesPath } from '../utils/paths.js';
import { encodeMetaValue, decodeMetaValue } from './parser.js';
import type { TodoBundle, BundleScope } from './types.js';

export { encodeMetaValue, decodeMetaValue };

const BUNDLE_ID_REGEX = /^[a-f0-9]{4}$/;
const SCOPE_VALUES = new Set<BundleScope>(['workspace', 'project', 'global']);
// Each bundle line: `- b:<id> <key=value;key=value;...>` — same `<...>;`
// container as src/todos/parser.ts uses for todo meta tokens, so a value can
// safely contain whitespace without fragmenting the line on read.
const BUNDLE_LINE_REGEX = /^- b:([a-f0-9]{4})\s+<([^>]*)>\s*$/;

export function generateShortBundleId(): string {
  return randomBytes(2).toString('hex');
}

export function generateUniqueBundleId(existing: Set<string>): string {
  let id = generateShortBundleId();
  let attempts = 0;
  while (existing.has(id) && attempts < 100) {
    id = generateShortBundleId();
    attempts++;
  }
  return id;
}

function parseScopeToken(raw: string): { scope: BundleScope; scopeId: string } | null {
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  const scopeRaw = raw.slice(0, idx);
  const scopeId = raw.slice(idx + 1);
  if (!SCOPE_VALUES.has(scopeRaw as BundleScope)) return null;
  if (!scopeId) return null;
  return { scope: scopeRaw as BundleScope, scopeId };
}

function parseTodosToken(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => BUNDLE_ID_REGEX.test(s));
}

// Body line shape (a single bundle):
//   `- b:<id> <key=value;key=value;...>`
// Recognized keys: slug, scope (value `<scope>:<scopeId>`), todos (CSV of
// 4-hex ids), branch, worktree, plan, repository, created, updated. Values
// are URL-encoded via encodeMetaValue (shared with todo parser). Unknown
// keys are dropped on read.
export function parseBundleLine(line: string): TodoBundle | null {
  const match = line.match(BUNDLE_LINE_REGEX);
  if (!match) return null;
  const id = match[1];
  const body = match[2];

  const fields: Record<string, string> = {};
  for (const pair of body.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = decodeMetaValue(trimmed.slice(eq + 1));
    fields[key] = value;
  }

  const scopeParsed = parseScopeToken(fields.scope ?? '');
  if (!scopeParsed) return null;

  const todoIds = parseTodosToken(fields.todos ?? '');
  const createdAt = fields.created ?? '';
  const updatedAt = fields.updated ?? '';
  if (!createdAt || !updatedAt) return null;

  return {
    id,
    slug: fields.slug ? fields.slug : null,
    scope: scopeParsed.scope,
    scopeId: scopeParsed.scopeId,
    todoIds,
    planDir: fields.plan ? fields.plan : null,
    branch: fields.branch ? fields.branch : null,
    worktreePath: fields.worktree ? fields.worktree : null,
    repository: fields.repository ? fields.repository : null,
    createdAt,
    updatedAt,
  };
}

export function serializeBundle(b: TodoBundle): string {
  const pairs: string[] = [];
  if (b.slug !== null) pairs.push(`slug=${encodeMetaValue(b.slug)}`);
  pairs.push(`scope=${encodeMetaValue(`${b.scope}:${b.scopeId}`)}`);
  pairs.push(`todos=${b.todoIds.join(',')}`);
  if (b.branch !== null) pairs.push(`branch=${encodeMetaValue(b.branch)}`);
  if (b.worktreePath !== null) pairs.push(`worktree=${encodeMetaValue(b.worktreePath)}`);
  if (b.planDir !== null) pairs.push(`plan=${encodeMetaValue(b.planDir)}`);
  if (b.repository !== null) pairs.push(`repository=${encodeMetaValue(b.repository)}`);
  pairs.push(`created=${encodeMetaValue(b.createdAt)}`);
  pairs.push(`updated=${encodeMetaValue(b.updatedAt)}`);
  return `- b:${b.id} <${pairs.join(';')}>`;
}

export interface ParsedBundles {
  version: string;
  bundles: TodoBundle[];
}

export function parseBundles(content: string): ParsedBundles {
  const [fm, body] = extractFrontmatter(content);
  const version = getField(fm, 'version') ?? '1';
  const bundles: TodoBundle[] = [];
  for (const line of body.split('\n')) {
    const b = parseBundleLine(line);
    if (b) bundles.push(b);
  }
  return { version, bundles };
}

export function serializeBundles(bundles: TodoBundle[]): string {
  const fm = ['---', 'version: "1"', '---'].join('\n');
  const header = '# Todo Bundles';
  const lines = bundles.map(serializeBundle).join('\n');
  return `${fm}\n\n${header}\n\n${lines}\n`;
}

export async function readBundles(todosDir: string): Promise<TodoBundle[]> {
  const path = bundlesPath(todosDir);
  if (!(await fileExists(path))) return [];
  const content = await readFile(path, 'utf-8');
  return parseBundles(content).bundles;
}

export async function writeBundles(todosDir: string, bundles: TodoBundle[]): Promise<void> {
  await ensureDir(bundlesDir(todosDir));
  await writeFileForce(bundlesPath(todosDir), serializeBundles(bundles));
}
