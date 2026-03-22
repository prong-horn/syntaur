import { readdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import { extractFrontmatter, getField } from './parser.js';
import type { SessionFileData } from './types.js';

export function sanitizeSessionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function nowTimestamp(): string {
  return new Date().toISOString();
}

function buildSessionContent(
  session: string,
  registered: string,
  lastRefreshed: string,
  overrides: Record<string, { mission: string; assignment: string }>,
): string {
  const lines = [
    '---',
    `session: ${session}`,
    `registered: ${registered}`,
    `last_refreshed: ${lastRefreshed}`,
  ];

  if (Object.keys(overrides).length > 0) {
    lines.push('overrides:');
    for (const [key, val] of Object.entries(overrides)) {
      lines.push(`  "${key}": { mission: "${val.mission}", assignment: "${val.assignment}" }`);
    }
  }

  lines.push('---', '');
  return lines.join('\n');
}

export async function registerSession(dir: string, rawName: string): Promise<string> {
  const name = sanitizeSessionName(rawName);
  await ensureDir(dir);
  const now = nowTimestamp();
  const content = buildSessionContent(name, now, now, {});
  await writeFileForce(resolve(dir, `${name}.md`), content);
  return name;
}

export async function listSessionFiles(dir: string): Promise<string[]> {
  if (!(await fileExists(dir))) return [];
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

export async function readSessionFile(dir: string, name: string): Promise<SessionFileData | null> {
  const filePath = resolve(dir, `${sanitizeSessionName(name)}.md`);
  if (!(await fileExists(filePath))) return null;

  const raw = await readFile(filePath, 'utf-8');
  const [frontmatter] = extractFrontmatter(raw);
  if (!frontmatter) return null;

  const session = getField(frontmatter, 'session') ?? name;
  const registered = getField(frontmatter, 'registered') ?? '';
  const lastRefreshed = getField(frontmatter, 'last_refreshed') ?? '';

  // Parse overrides block
  const overrides: Record<string, { mission: string; assignment: string }> = {};
  const overridesMatch = frontmatter.match(/^overrides:\n((?:\s+".+\n?)*)/m);
  if (overridesMatch) {
    const overrideLines = overridesMatch[1].matchAll(
      /^\s+"([^"]+)":\s*\{\s*mission:\s*"([^"]+)",\s*assignment:\s*"([^"]+)"\s*\}/gm,
    );
    for (const m of overrideLines) {
      overrides[m[1]] = { mission: m[2], assignment: m[3] };
    }
  }

  return { session, registered, lastRefreshed, overrides };
}

export async function removeSession(dir: string, name: string): Promise<void> {
  const filePath = resolve(dir, `${sanitizeSessionName(name)}.md`);
  if (await fileExists(filePath)) {
    await unlink(filePath);
  }
}

export async function updateLastRefreshed(dir: string, name: string): Promise<void> {
  const data = await readSessionFile(dir, name);
  if (!data) return;
  const content = buildSessionContent(data.session, data.registered, nowTimestamp(), data.overrides);
  await writeFileForce(resolve(dir, `${sanitizeSessionName(name)}.md`), content);
}

export async function setOverride(
  dir: string,
  sessionName: string,
  windowIndex: number,
  paneIndex: number,
  assignment: { mission: string; assignment: string } | null,
): Promise<void> {
  const data = await readSessionFile(dir, sessionName);
  if (!data) return;
  const key = `${windowIndex}:${paneIndex}`;
  if (assignment) {
    data.overrides[key] = assignment;
  } else {
    delete data.overrides[key];
  }
  const content = buildSessionContent(data.session, data.registered, data.lastRefreshed, data.overrides);
  await writeFileForce(resolve(dir, `${sanitizeSessionName(sessionName)}.md`), content);
}
