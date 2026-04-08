import { readdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import { extractFrontmatter, getField } from './parser.js';
import type { SessionFileData, SessionKind } from './types.js';

export function sanitizeSessionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function nowTimestamp(): string {
  return new Date().toISOString();
}

export interface BuildSessionOptions {
  session: string;
  registered: string;
  lastRefreshed: string;
  overrides: Record<string, { mission: string; assignment: string }>;
  auto?: boolean;
  kind?: SessionKind;
  pid?: number;
  ports?: number[];
  cwd?: string;
}

export function buildSessionContent(opts: BuildSessionOptions): string {
  const lines = [
    '---',
    `session: ${opts.session}`,
    `registered: ${opts.registered}`,
    `last_refreshed: ${opts.lastRefreshed}`,
  ];

  if (opts.auto != null) {
    lines.push(`auto: ${opts.auto}`);
  }
  if (opts.kind) {
    lines.push(`kind: ${opts.kind}`);
  }
  if (opts.pid != null) {
    lines.push(`pid: ${opts.pid}`);
  }
  if (opts.ports && opts.ports.length > 0) {
    lines.push(`ports: [${opts.ports.join(', ')}]`);
  }
  if (opts.cwd) {
    lines.push(`cwd: ${opts.cwd}`);
  }

  if (Object.keys(opts.overrides).length > 0) {
    lines.push('overrides:');
    for (const [key, val] of Object.entries(opts.overrides)) {
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
  const content = buildSessionContent({
    session: name, registered: now, lastRefreshed: now, overrides: {},
  });
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

  const autoField = getField(frontmatter, 'auto');
  const auto = autoField === 'true' ? true : autoField === 'false' ? false : undefined;
  const kind = getField(frontmatter, 'kind') as SessionKind | undefined;
  const pidField = getField(frontmatter, 'pid');
  const pid = pidField ? parseInt(pidField, 10) : undefined;
  const cwdField = getField(frontmatter, 'cwd');

  let ports: number[] | undefined;
  const portsMatch = frontmatter.match(/^ports:\s*\[([^\]]*)\]/m);
  if (portsMatch) {
    ports = portsMatch[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
  }

  return {
    session, registered, lastRefreshed, overrides,
    ...(auto != null && { auto }),
    ...(kind && { kind }),
    ...(pid != null && !isNaN(pid) && { pid }),
    ...(ports && ports.length > 0 && { ports }),
    ...(cwdField && { cwd: cwdField }),
  };
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
  const content = buildSessionContent({ ...data, lastRefreshed: nowTimestamp() });
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
  const content = buildSessionContent({ ...data });
  await writeFileForce(resolve(dir, `${sanitizeSessionName(sessionName)}.md`), content);
}

export interface RegisterAutoOptions {
  kind: SessionKind;
  pid?: number;
  ports?: number[];
  cwd?: string;
}

export async function registerAutoSession(
  dir: string,
  rawName: string,
  opts: RegisterAutoOptions,
): Promise<string> {
  const name = sanitizeSessionName(rawName);
  await ensureDir(dir);
  const now = nowTimestamp();
  const content = buildSessionContent({
    session: name,
    registered: now,
    lastRefreshed: now,
    overrides: {},
    auto: true,
    kind: opts.kind,
    pid: opts.pid,
    ports: opts.ports,
    cwd: opts.cwd,
  });
  await writeFileForce(resolve(dir, `${name}.md`), content);
  return name;
}
