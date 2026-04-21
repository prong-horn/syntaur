# Server Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track locally running dev servers in tmux sessions, showing ports, branches, worktrees, and assignment links in the Syntaur dashboard.

**Architecture:** File-based registration (markdown + YAML frontmatter) at `~/.syntaur/servers/`, with server-side tmux/lsof scanning on demand. Express API serves cached scan data. React dashboard displays sessions with contextual integration on existing pages.

**Tech Stack:** TypeScript, Express 5, React, chokidar, WebSocket (ws), child_process (execFile), Tailwind CSS, Vitest

**Spec:** `docs/superpowers/specs/2026-03-22-server-tracker-design.md`

---

### Task 1: Types, Path Helpers & Parser Exports

**Files:**
- Modify: `src/dashboard/types.ts:278-291` (WsMessageType, WsMessage)
- Modify: `src/utils/paths.ts:1-17`
- Modify: `src/dashboard/parser.ts:42,51` (export getField, getNestedField)
- Test: `src/__tests__/server-tracker.test.ts` (new)

- [ ] **Step 1: Write the failing test for serversDir path helper**

```typescript
// src/__tests__/server-tracker.test.ts
import { describe, it, expect } from 'vitest';
import { serversDir } from '../utils/paths.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

describe('serversDir', () => {
  it('returns ~/.syntaur/servers', () => {
    expect(serversDir()).toBe(resolve(homedir(), '.syntaur', 'servers'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/server-tracker.test.ts`
Expected: FAIL — `serversDir` is not exported

- [ ] **Step 3: Add serversDir to paths.ts**

Add to `src/utils/paths.ts` after `defaultProjectDir()`:

```typescript
export function serversDir(): string {
  return resolve(syntaurRoot(), 'servers');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/server-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Add server tracker types to types.ts**

Add to `src/dashboard/types.ts` — update the WsMessageType union and add new types:

```typescript
// Update existing WsMessageType (line 280):
export type WsMessageType =
  | 'project-updated'
  | 'assignment-updated'
  | 'servers-updated'
  | 'connected';

// Add after WsMessage (after line 290):

// --- Server Tracker Types ---

export interface TrackedSession {
  name: string;
  registered: string;
  lastRefreshed: string;
  scannedAt: string;
  alive: boolean;
  windows: TrackedWindow[];
}

export interface TrackedWindow {
  index: number;
  name: string;
  panes: TrackedPane[];
}

export interface TrackedPane {
  index: number;
  command: string;
  cwd: string;
  branch: string | null;
  worktree: boolean;
  ports: number[];
  urls: string[];
  assignment: {
    project: string;
    slug: string;
    title: string;
  } | null;
}

export interface ServersResponse {
  sessions: TrackedSession[];
  tmuxAvailable: boolean;
}

export interface SessionFileData {
  session: string;
  registered: string;
  lastRefreshed: string;
  overrides: Record<string, { project: string; assignment: string }>;
}
```

- [ ] **Step 6: Export getField and getNestedField from parser.ts**

In `src/dashboard/parser.ts`, add `export` keyword to both functions (they are currently private):

- Line 42: change `function getField(` to `export function getField(`
- Line 51: change `function getNestedField(` to `export function getNestedField(`

These are needed by `servers.ts` and `scanner.ts` in later tasks.

- [ ] **Step 7: Update frontend WsMessage type in useWebSocket.ts**

In `dashboard/src/hooks/useWebSocket.ts` line 3-8, add `'servers-updated'` to the type union:

```typescript
export interface WsMessage {
  type: 'project-updated' | 'assignment-updated' | 'servers-updated' | 'connected';
  projectSlug?: string;
  assignmentSlug?: string;
  timestamp: string;
}
```

- [ ] **Step 8: Commit**

```bash
git add src/utils/paths.ts src/dashboard/types.ts src/dashboard/parser.ts dashboard/src/hooks/useWebSocket.ts src/__tests__/server-tracker.test.ts
git commit -m "feat(server-tracker): add types and serversDir path helper"
```

---

### Task 2: Session File I/O (Register, Read, Delete)

**Files:**
- Create: `src/dashboard/servers.ts`
- Modify: `src/__tests__/server-tracker.test.ts`

- [ ] **Step 1: Write failing tests for session file operations**

Add to `src/__tests__/server-tracker.test.ts`:

```typescript
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeSessionName,
  registerSession,
  listSessionFiles,
  readSessionFile,
  removeSession,
  updateLastRefreshed,
} from '../dashboard/servers.js';

describe('sanitizeSessionName', () => {
  it('passes alphanumeric names through', () => {
    expect(sanitizeSessionName('my-session_1')).toBe('my-session_1');
  });
  it('replaces dots and colons with hyphens', () => {
    expect(sanitizeSessionName('my.session:name')).toBe('my-session-name');
  });
  it('replaces other special characters', () => {
    expect(sanitizeSessionName('a/b@c')).toBe('a-b-c');
  });
});

describe('session file I/O', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'syntaur-servers-'));
  });
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('registerSession creates a file with frontmatter', async () => {
    await registerSession(testDir, 'my-stack');
    const data = await readSessionFile(testDir, 'my-stack');
    expect(data).not.toBeNull();
    expect(data!.session).toBe('my-stack');
    expect(data!.registered).toBeTruthy();
    expect(data!.overrides).toEqual({});
  });

  it('listSessionFiles returns registered sessions', async () => {
    await registerSession(testDir, 'stack-a');
    await registerSession(testDir, 'stack-b');
    const names = await listSessionFiles(testDir);
    expect(names.sort()).toEqual(['stack-a', 'stack-b']);
  });

  it('removeSession deletes the file', async () => {
    await registerSession(testDir, 'my-stack');
    await removeSession(testDir, 'my-stack');
    const data = await readSessionFile(testDir, 'my-stack');
    expect(data).toBeNull();
  });

  it('updateLastRefreshed updates the timestamp', async () => {
    await registerSession(testDir, 'my-stack');
    const before = await readSessionFile(testDir, 'my-stack');
    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 10));
    await updateLastRefreshed(testDir, 'my-stack');
    const after = await readSessionFile(testDir, 'my-stack');
    expect(after!.lastRefreshed).not.toBe(before!.lastRefreshed);
  });

  it('registerSession with sanitization works', async () => {
    await registerSession(testDir, 'my.session:1');
    const names = await listSessionFiles(testDir);
    expect(names).toEqual(['my-session-1']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/server-tracker.test.ts`
Expected: FAIL — module `../dashboard/servers.js` not found

- [ ] **Step 3: Implement session file operations**

Create `src/dashboard/servers.ts`:

```typescript
import { readdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import { extractFrontmatter, getField, getNestedField } from './parser.js';
import type { SessionFileData } from './types.js';

export function sanitizeSessionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function nowTimestamp(): string {
  return new Date().toISOString();
}

function buildSessionContent(session: string, registered: string, lastRefreshed: string, overrides: Record<string, { project: string; assignment: string }>): string {
  const lines = [
    '---',
    `session: ${session}`,
    `registered: ${registered}`,
    `last_refreshed: ${lastRefreshed}`,
  ];

  if (Object.keys(overrides).length > 0) {
    lines.push('overrides:');
    for (const [key, val] of Object.entries(overrides)) {
      lines.push(`  "${key}": { project: "${val.project}", assignment: "${val.assignment}" }`);
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
  const overrides: Record<string, { project: string; assignment: string }> = {};
  const overridesMatch = frontmatter.match(/^overrides:\n((?:\s+".+\n?)*)/m);
  if (overridesMatch) {
    const overrideLines = overridesMatch[1].matchAll(/^\s+"([^"]+)":\s*\{\s*project:\s*"([^"]+)",\s*assignment:\s*"([^"]+)"\s*\}/gm);
    for (const m of overrideLines) {
      overrides[m[1]] = { project: m[2], assignment: m[3] };
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
  assignment: { project: string; assignment: string } | null,
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/server-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/servers.ts src/__tests__/server-tracker.test.ts
git commit -m "feat(server-tracker): session file I/O — register, read, list, remove"
```

---

### Task 3: Tmux Scanner

**Files:**
- Create: `src/dashboard/scanner.ts`
- Create: `src/__tests__/scanner.test.ts`

- [ ] **Step 1: Write failing tests for the scanner**

Create `src/__tests__/scanner.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  checkTmuxAvailable,
  parseTmuxPaneOutput,
  getDescendantPids,
  findListeningPorts,
  getGitInfo,
} from '../dashboard/scanner.js';

describe('parseTmuxPaneOutput', () => {
  it('parses pipe-delimited pane lines', () => {
    const output = [
      '0|main|0|zsh|/Users/test/project|12345',
      '0|main|1|node|/Users/test/project|12346',
      '1|server|0|python|/Users/test/api|12347',
    ].join('\n');

    const result = parseTmuxPaneOutput(output);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      windowIndex: 0,
      windowName: 'main',
      paneIndex: 0,
      command: 'zsh',
      cwd: '/Users/test/project',
      pid: 12345,
    });
    expect(result[2]).toEqual({
      windowIndex: 1,
      windowName: 'server',
      paneIndex: 0,
      command: 'python',
      cwd: '/Users/test/api',
      pid: 12347,
    });
  });

  it('returns empty array for empty output', () => {
    expect(parseTmuxPaneOutput('')).toEqual([]);
  });
});

describe('findListeningPorts', () => {
  it('extracts ports from lsof output for matching PIDs', () => {
    const lsofOutput = [
      'node    12346 user    5u  IPv4 0x1234  0t0  TCP *:3000 (LISTEN)',
      'node    12346 user    6u  IPv4 0x1235  0t0  TCP *:3001 (LISTEN)',
      'python  99999 user    4u  IPv4 0x1236  0t0  TCP *:8080 (LISTEN)',
    ].join('\n');

    const ports = findListeningPorts(lsofOutput, new Set([12346]));
    expect(ports.sort()).toEqual([3000, 3001]);
  });

  it('returns empty for no matching PIDs', () => {
    const lsofOutput = 'python  99999 user    4u  IPv4 0x1236  0t0  TCP *:8080 (LISTEN)';
    expect(findListeningPorts(lsofOutput, new Set([12345]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/scanner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the scanner module**

Create `src/dashboard/scanner.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { listProjects } from './api.js';
import {
  readSessionFile,
  listSessionFiles,
  updateLastRefreshed,
} from './servers.js';
import type {
  TrackedSession,
  TrackedWindow,
  TrackedPane,
  ServersResponse,
  SessionFileData,
} from './types.js';

const exec = promisify(execFile);

// --- Cache ---
let cache: { data: ServersResponse; expiry: number } | null = null;
const CACHE_TTL_MS = 10_000;

export function clearScanCache(): void {
  cache = null;
}

// --- Pure parsing functions (exported for testing) ---

export interface RawPane {
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  command: string;
  cwd: string;
  pid: number;
}

export function parseTmuxPaneOutput(output: string): RawPane[] {
  return output
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [wi, wn, pi, cmd, cwd, pid] = line.split('|');
      return {
        windowIndex: parseInt(wi, 10),
        windowName: wn,
        paneIndex: parseInt(pi, 10),
        command: cmd,
        cwd,
        pid: parseInt(pid, 10),
      };
    });
}

export function findListeningPorts(lsofOutput: string, pids: Set<number>): number[] {
  const ports: number[] = [];
  for (const line of lsofOutput.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = parseInt(parts[1], 10);
    if (!pids.has(pid)) continue;
    // Find port from TCP address like *:3000 or 127.0.0.1:8080
    const tcpAddr = parts.find((p) => p.includes(':') && /:\d+$/.test(p));
    if (tcpAddr) {
      const port = parseInt(tcpAddr.split(':').pop()!, 10);
      if (!isNaN(port) && !ports.includes(port)) {
        ports.push(port);
      }
    }
  }
  return ports;
}

// --- Shell helpers ---

async function execQuiet(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args);
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function checkTmuxAvailable(): Promise<boolean> {
  const result = await execQuiet('which', ['tmux']);
  return result.length > 0;
}

async function sessionAlive(name: string): Promise<boolean> {
  try {
    await exec('tmux', ['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

async function listTmuxPanes(sessionName: string): Promise<RawPane[]> {
  const output = await execQuiet('tmux', [
    'list-panes', '-s', '-t', sessionName,
    '-F', '#{window_index}|#{window_name}|#{pane_index}|#{pane_current_command}|#{pane_current_path}|#{pane_pid}',
  ]);
  return parseTmuxPaneOutput(output);
}

export async function getDescendantPids(rootPid: number, maxDepth: number = 4): Promise<Set<number>> {
  const all = new Set<number>([rootPid]);
  let frontier = [rootPid];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: number[] = [];
    for (const pid of frontier) {
      const output = await execQuiet('pgrep', ['-P', String(pid)]);
      for (const line of output.split('\n')) {
        const child = parseInt(line, 10);
        if (!isNaN(child) && !all.has(child)) {
          all.add(child);
          nextFrontier.push(child);
        }
      }
    }
    frontier = nextFrontier;
  }

  return all;
}

async function getLsofOutput(): Promise<string> {
  return execQuiet('lsof', ['-i', '-P', '-n', '-sTCP:LISTEN']);
}

export async function getGitInfo(cwd: string): Promise<{ branch: string | null; worktree: boolean }> {
  const branch = await execQuiet('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return { branch: null, worktree: false };

  const commonDir = await execQuiet('git', ['-C', cwd, 'rev-parse', '--git-common-dir']);
  const gitDir = await execQuiet('git', ['-C', cwd, 'rev-parse', '--git-dir']);

  // If git-common-dir is absolute and differs from git-dir, it's a worktree
  let isWorktree = false;
  if (commonDir && gitDir && commonDir !== gitDir) {
    try {
      const resolvedCommon = await realpath(resolve(cwd, commonDir));
      const resolvedGit = await realpath(resolve(cwd, gitDir));
      isWorktree = resolvedCommon !== resolvedGit;
    } catch {
      isWorktree = false;
    }
  }

  return { branch: branch || null, worktree: isWorktree };
}

// --- Auto-linking ---

interface AssignmentLink {
  project: string;
  slug: string;
  title: string;
}

interface WorkspaceRecord {
  projectSlug: string;
  assignmentSlug: string;
  assignmentTitle: string;
  worktreePath: string | null;
  branch: string | null;
}

async function loadWorkspaceRecords(projectsDir: string): Promise<WorkspaceRecord[]> {
  const records: WorkspaceRecord[] = [];
  try {
    const projects = await listProjects(projectsDir);
    // We need full assignment details for workspace info — use a lightweight approach
    const { readdir, readFile: readF } = await import('node:fs/promises');
    const { extractFrontmatter, getField, getNestedField } = await import('./parser.js');

    for (const project of projects) {
      const assignmentsDir = resolve(projectsDir, project.slug, 'assignments');
      let slugs: string[];
      try {
        slugs = await readdir(assignmentsDir);
      } catch {
        continue;
      }
      for (const aslug of slugs) {
        const aFile = resolve(assignmentsDir, aslug, 'assignment.md');
        try {
          const raw = await readF(aFile, 'utf-8');
          const [fm] = extractFrontmatter(raw);
          if (!fm) continue;
          records.push({
            projectSlug: project.slug,
            assignmentSlug: aslug,
            assignmentTitle: getField(fm, 'title') ?? aslug,
            worktreePath: getNestedField(fm, 'workspace', 'worktreePath') ?? null,
            branch: getNestedField(fm, 'workspace', 'branch') ?? null,
          });
        } catch {
          continue;
        }
      }
    }
  } catch {
    // If projects can't be loaded, auto-linking just returns no matches
  }
  return records;
}

async function resolveAndNormalize(p: string): Promise<string> {
  try {
    const resolved = await realpath(p);
    return resolved.replace(/\/+$/, '');
  } catch {
    return p.replace(/\/+$/, '');
  }
}

async function autoLinkPane(
  cwd: string,
  branch: string | null,
  records: WorkspaceRecord[],
): Promise<AssignmentLink | null> {
  // First try: exact cwd match against worktreePath (resolve symlinks per spec)
  const normalizedCwd = await resolveAndNormalize(cwd);
  for (const rec of records) {
    if (rec.worktreePath) {
      const normalizedWt = await resolveAndNormalize(rec.worktreePath);
      if (normalizedCwd === normalizedWt) {
        return { project: rec.projectSlug, slug: rec.assignmentSlug, title: rec.assignmentTitle };
      }
    }
  }
  // Fallback: branch match
  if (branch) {
    for (const rec of records) {
      if (rec.branch && rec.branch === branch) {
        return { project: rec.projectSlug, slug: rec.assignmentSlug, title: rec.assignmentTitle };
      }
    }
  }
  return null;
}

// --- Main scan function ---

async function scanSession(
  sessionData: SessionFileData,
  lsofOutput: string,
  workspaceRecords: WorkspaceRecord[],
): Promise<TrackedSession> {
  const now = new Date().toISOString();
  const alive = await sessionAlive(sessionData.session);

  if (!alive) {
    return {
      name: sessionData.session,
      registered: sessionData.registered,
      lastRefreshed: sessionData.lastRefreshed,
      scannedAt: now,
      alive: false,
      windows: [],
    };
  }

  const rawPanes = await listTmuxPanes(sessionData.session);

  // Group panes by window
  const windowMap = new Map<number, { name: string; panes: RawPane[] }>();
  for (const rp of rawPanes) {
    if (!windowMap.has(rp.windowIndex)) {
      windowMap.set(rp.windowIndex, { name: rp.windowName, panes: [] });
    }
    windowMap.get(rp.windowIndex)!.panes.push(rp);
  }

  // Get git info per unique cwd
  const cwdSet = new Set(rawPanes.map((p) => p.cwd));
  const gitInfoCache = new Map<string, { branch: string | null; worktree: boolean }>();
  for (const cwd of cwdSet) {
    gitInfoCache.set(cwd, await getGitInfo(cwd));
  }

  // Get all descendant PIDs for port lookup
  const pidToPaneKey = new Map<number, string>();
  for (const rp of rawPanes) {
    const descendants = await getDescendantPids(rp.pid);
    const key = `${rp.windowIndex}:${rp.paneIndex}`;
    for (const pid of descendants) {
      pidToPaneKey.set(pid, key);
    }
  }

  // Find ports per pane
  const panePorts = new Map<string, number[]>();
  for (const line of lsofOutput.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = parseInt(parts[1], 10);
    const paneKey = pidToPaneKey.get(pid);
    if (!paneKey) continue;
    const tcpAddr = parts.find((p) => p.includes(':') && /:\d+$/.test(p));
    if (tcpAddr) {
      const port = parseInt(tcpAddr.split(':').pop()!, 10);
      if (!isNaN(port)) {
        if (!panePorts.has(paneKey)) panePorts.set(paneKey, []);
        const existing = panePorts.get(paneKey)!;
        if (!existing.includes(port)) existing.push(port);
      }
    }
  }

  // Build windows
  const windows: TrackedWindow[] = [];
  for (const [windowIndex, { name, panes: rawPanesInWindow }] of windowMap) {
    const panes: TrackedPane[] = rawPanesInWindow.map((rp) => {
      const key = `${rp.windowIndex}:${rp.paneIndex}`;
      const gitInfo = gitInfoCache.get(rp.cwd) ?? { branch: null, worktree: false };
      const ports = panePorts.get(key) ?? [];
      const urls = ports.map((p) => `http://localhost:${p}`);

      // Check override first, then auto-link
      const override = sessionData.overrides[key];
      let assignment: AssignmentLink | null = null;
      if (override) {
        // We have an override but need the title — find it in workspace records
        const rec = workspaceRecords.find(
          (r) => r.projectSlug === override.project && r.assignmentSlug === override.assignment,
        );
        assignment = {
          project: override.project,
          slug: override.assignment,
          title: rec?.assignmentTitle ?? override.assignment,
        };
      } else {
        assignment = await autoLinkPane(rp.cwd, gitInfo.branch, workspaceRecords);
      }

      return {
        index: rp.paneIndex,
        command: rp.command,
        cwd: rp.cwd,
        branch: gitInfo.branch,
        worktree: gitInfo.worktree,
        ports,
        urls,
        assignment,
      };
    });

    windows.push({ index: windowIndex, name, panes });
  }

  windows.sort((a, b) => a.index - b.index);

  return {
    name: sessionData.session,
    registered: sessionData.registered,
    lastRefreshed: sessionData.lastRefreshed,
    scannedAt: now,
    alive: true,
    windows,
  };
}

export async function scanAllSessions(
  serversDir: string,
  projectsDir: string,
  options?: { bypassCache?: boolean },
): Promise<ServersResponse> {
  // Check cache
  if (!options?.bypassCache && cache && Date.now() < cache.expiry) {
    return cache.data;
  }

  const tmuxAvailable = await checkTmuxAvailable();
  if (!tmuxAvailable) {
    const result = { sessions: [], tmuxAvailable: false };
    cache = { data: result, expiry: Date.now() + CACHE_TTL_MS };
    return result;
  }

  const names = await listSessionFiles(serversDir);
  const lsofOutput = await getLsofOutput();
  const workspaceRecords = await loadWorkspaceRecords(projectsDir);

  const sessions: TrackedSession[] = [];
  for (const name of names) {
    const data = await readSessionFile(serversDir, name);
    if (!data) continue;
    sessions.push(await scanSession(data, lsofOutput, workspaceRecords));
  }

  const result: ServersResponse = { sessions, tmuxAvailable: true };
  cache = { data: result, expiry: Date.now() + CACHE_TTL_MS };
  return result;
}

export async function scanSingleSession(
  serversDir: string,
  projectsDir: string,
  name: string,
): Promise<TrackedSession | null> {
  const data = await readSessionFile(serversDir, name);
  if (!data) return null;

  const lsofOutput = await getLsofOutput();
  const workspaceRecords = await loadWorkspaceRecords(projectsDir);
  return scanSession(data, lsofOutput, workspaceRecords);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/scanner.test.ts`
Expected: PASS (the pure parsing tests should pass; shell-dependent tests are covered by the parsing functions)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/scanner.ts src/__tests__/scanner.test.ts
git commit -m "feat(server-tracker): tmux scanner with port detection and auto-linking"
```

---

### Task 4: Servers API Router

**Files:**
- Create: `src/dashboard/api-servers.ts`
- Modify: `src/dashboard/server.ts:1-30` (imports), `src/dashboard/server.ts:22-26` (DashboardServerOptions), `src/dashboard/server.ts:73-155` (mount router)

- [ ] **Step 1: Write the servers API router**

Create `src/dashboard/api-servers.ts`:

```typescript
import { Router } from 'express';
import {
  registerSession,
  removeSession,
  listSessionFiles,
  readSessionFile,
  updateLastRefreshed,
  setOverride,
  sanitizeSessionName,
} from './servers.js';
import {
  scanAllSessions,
  scanSingleSession,
  clearScanCache,
} from './scanner.js';
import { ensureDir } from '../utils/fs.js';

export function createServersRouter(serversDir: string, projectsDir: string): Router {
  const router = Router();

  // GET /api/servers — all sessions with cached scan data
  router.get('/', async (_req, res) => {
    try {
      const result = await scanAllSessions(serversDir, projectsDir);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Scan failed' });
    }
  });

  // GET /api/servers/:name — single session
  router.get('/:name', async (req, res) => {
    try {
      const session = await scanSingleSession(serversDir, projectsDir, req.params.name);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json(session);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Scan failed' });
    }
  });

  // POST /api/servers — register a new session
  router.post('/', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const sanitized = sanitizeSessionName(name);
      const existing = await readSessionFile(serversDir, sanitized);
      if (existing) {
        res.status(409).json({ error: `Session "${sanitized}" already registered` });
        return;
      }
      await registerSession(serversDir, name);
      clearScanCache();
      res.status(201).json({ name: sanitized });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed' });
    }
  });

  // DELETE /api/servers/:name — unregister
  router.delete('/:name', async (req, res) => {
    try {
      const data = await readSessionFile(serversDir, req.params.name);
      if (!data) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await removeSession(serversDir, req.params.name);
      clearScanCache();
      res.json({ removed: req.params.name });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Removal failed' });
    }
  });

  // POST /api/servers/refresh — fresh scan all
  router.post('/refresh', async (_req, res) => {
    try {
      const names = await listSessionFiles(serversDir);
      for (const name of names) {
        await updateLastRefreshed(serversDir, name);
      }
      clearScanCache();
      const result = await scanAllSessions(serversDir, projectsDir, { bypassCache: true });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Refresh failed' });
    }
  });

  // POST /api/servers/:name/refresh — fresh scan one
  router.post('/:name/refresh', async (req, res) => {
    try {
      const data = await readSessionFile(serversDir, req.params.name);
      if (!data) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await updateLastRefreshed(serversDir, req.params.name);
      clearScanCache();
      const session = await scanSingleSession(serversDir, projectsDir, req.params.name);
      res.json(session);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Refresh failed' });
    }
  });

  // PATCH /api/servers/:name/panes/:windowIndex/:paneIndex/assignment — manual link
  router.patch('/:name/panes/:windowIndex/:paneIndex/assignment', async (req, res) => {
    try {
      const { name, windowIndex, paneIndex } = req.params;
      const data = await readSessionFile(serversDir, name);
      if (!data) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const body = req.body; // { project, assignment } | null
      if (body === null || (body && body.project && body.assignment)) {
        await setOverride(
          serversDir,
          name,
          parseInt(windowIndex, 10),
          parseInt(paneIndex, 10),
          body,
        );
        clearScanCache();
        res.json({ updated: true });
      } else {
        res.status(400).json({ error: 'Body must be { project, assignment } or null' });
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Update failed' });
    }
  });

  return router;
}
```

- [ ] **Step 2: Update DashboardServerOptions and mount the router in server.ts**

In `src/dashboard/server.ts`:

1. Add import at top:
```typescript
import { createServersRouter } from './api-servers.js';
```

2. Update `DashboardServerOptions` (line 22-26):
```typescript
export interface DashboardServerOptions {
  port: number;
  projectsDir: string;
  serversDir: string;
  devMode: boolean;
}
```

3. Destructure `serversDir` in `createDashboardServer` (line 29):
```typescript
const { port, projectsDir, serversDir, devMode } = options;
```

4. Mount servers router after the write router (after line 158 `app.use(createWriteRouter(projectsDir))`):
```typescript
app.use('/api/servers', createServersRouter(serversDir, projectsDir));
```

- [ ] **Step 3: Update dashboard command to pass serversDir**

Check `src/commands/dashboard.ts` and update the call to `createDashboardServer` to include `serversDir`. Import `serversDir` from `../utils/paths.js`:

```typescript
import { serversDir as getServersDir } from '../utils/paths.js';
```

And in the options:
```typescript
serversDir: getServersDir(),
```

- [ ] **Step 4: Run existing tests to check nothing is broken**

Run: `npx vitest run`
Expected: All existing tests pass (some may need `serversDir` added to test fixtures)

- [ ] **Step 5: Fix any test failures from the new required option**

If `src/__tests__/dashboard-api.test.ts` or `src/__tests__/dashboard-write.test.ts` fail because `DashboardServerOptions` now requires `serversDir`, update those test fixtures to include a temp `serversDir`.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/api-servers.ts src/dashboard/server.ts src/commands/dashboard.ts
git commit -m "feat(server-tracker): servers API router with CRUD and scan endpoints"
```

---

### Task 5: File Watcher Extension

**Files:**
- Modify: `src/dashboard/watcher.ts:1-70`
- Modify: `src/dashboard/server.ts:184-187` (pass serversDir to watcher)

- [ ] **Step 1: Update WatcherOptions and add servers watcher**

In `src/dashboard/watcher.ts`, update the interface and create a second chokidar instance:

```typescript
import { watch } from 'chokidar';
import { relative, sep } from 'node:path';
import type { WsMessage } from './types.js';

export interface WatcherOptions {
  projectsDir: string;
  serversDir?: string;
  onMessage: (message: WsMessage) => void;
  debounceMs?: number;
}

export function createWatcher(options: WatcherOptions): { close: () => Promise<void> } {
  const { projectsDir, serversDir, onMessage, debounceMs = 300 } = options;
  const pendingEvents = new Map<string, NodeJS.Timeout>();

  // --- Projects watcher (existing) ---
  const missionsWatcher = watch(projectsDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 10,
    ignored: /(^|[\/\\])\../,
  });

  function handleMissionChange(filePath: string): void {
    const rel = relative(projectsDir, filePath);
    const parts = rel.split(sep);

    if (parts.length === 0) return;

    const projectSlug = parts[0];
    let assignmentSlug: string | undefined;

    if (parts.length >= 3 && parts[1] === 'assignments') {
      assignmentSlug = parts[2];
    }

    const debounceKey = assignmentSlug
      ? `${projectSlug}/${assignmentSlug}`
      : projectSlug;

    const existing = pendingEvents.get(debounceKey);
    if (existing) clearTimeout(existing);

    pendingEvents.set(
      debounceKey,
      setTimeout(() => {
        pendingEvents.delete(debounceKey);
        const message: WsMessage = {
          type: assignmentSlug ? 'assignment-updated' : 'project-updated',
          projectSlug,
          assignmentSlug,
          timestamp: new Date().toISOString(),
        };
        onMessage(message);
      }, debounceMs),
    );
  }

  missionsWatcher.on('change', handleMissionChange);
  missionsWatcher.on('add', handleMissionChange);
  missionsWatcher.on('unlink', handleMissionChange);

  // --- Servers watcher (new) ---
  let serversWatcher: ReturnType<typeof watch> | null = null;

  if (serversDir) {
    serversWatcher = watch(serversDir, {
      ignoreInitial: true,
      persistent: true,
      depth: 1,
      ignored: /(^|[\/\\])\../,
    });

    function handleServerChange(): void {
      const debounceKey = '__servers__';
      const existing = pendingEvents.get(debounceKey);
      if (existing) clearTimeout(existing);

      pendingEvents.set(
        debounceKey,
        setTimeout(() => {
          pendingEvents.delete(debounceKey);
          const message: WsMessage = {
            type: 'servers-updated',
            timestamp: new Date().toISOString(),
          };
          onMessage(message);
        }, debounceMs),
      );
    }

    serversWatcher.on('change', handleServerChange);
    serversWatcher.on('add', handleServerChange);
    serversWatcher.on('unlink', handleServerChange);
  }

  return {
    close: async () => {
      pendingEvents.forEach((timeout) => {
        clearTimeout(timeout);
      });
      pendingEvents.clear();
      await missionsWatcher.close();
      if (serversWatcher) await serversWatcher.close();
    },
  };
}
```

- [ ] **Step 2: Pass serversDir to watcher in server.ts**

Update `server.ts` line 184-187 to pass `serversDir`:

```typescript
watcherHandle = createWatcher({
  projectsDir,
  serversDir,
  onMessage: broadcast,
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/watcher.ts src/dashboard/server.ts
git commit -m "feat(server-tracker): extend file watcher to watch servers directory"
```

---

### Task 6: Frontend Data Hooks

**Files:**
- Modify: `dashboard/src/hooks/useProjects.ts` (add WebSocket scope, add hooks)
- Modify: `dashboard/src/hooks/useWebSocket.ts` (extend WsMessage type if needed)

- [ ] **Step 1: Extend useFetch to handle 'servers' scope**

In `dashboard/src/hooks/useProjects.ts`:

1. Update the `websocketScope` parameter type on line 275 to include `'servers'`:

```typescript
function useFetch<T>(url: string | null, websocketScope?: 'projects' | 'project' | 'assignment' | 'assignments' | 'overview' | 'attention' | 'servers'): FetchState<T> {
```

2. Update the WebSocket handler (lines 322-330) to also handle `'servers-updated'`:

```typescript
  useWebSocket((message: WsMessage) => {
    if (!websocketScope) {
      return;
    }

    if (message.type === 'project-updated' || message.type === 'assignment-updated') {
      refetch();
    }
    if (message.type === 'servers-updated' && websocketScope === 'servers') {
      refetch();
    }
  });
```

Note: the variable is `refetch` (not `refetchFn`), defined on line 281.

- [ ] **Step 2: Create frontend types file**

Create `dashboard/src/types.ts` with the shared types (mirroring the backend types needed by the frontend). This file must exist before the hooks can reference it:

```typescript
export interface TrackedSession {
  name: string;
  registered: string;
  lastRefreshed: string;
  scannedAt: string;
  alive: boolean;
  windows: TrackedWindow[];
}

export interface TrackedWindow {
  index: number;
  name: string;
  panes: TrackedPane[];
}

export interface TrackedPane {
  index: number;
  command: string;
  cwd: string;
  branch: string | null;
  worktree: boolean;
  ports: number[];
  urls: string[];
  assignment: {
    project: string;
    slug: string;
    title: string;
  } | null;
}

export interface ServersResponse {
  sessions: TrackedSession[];
  tmuxAvailable: boolean;
}
```

Also add `OverviewServerStats` to this file (needed by the Overview page in Task 8):

```typescript
export interface OverviewServerStats {
  trackedSessions: number;
  aliveSessions: number;
  deadSessions: number;
  totalPorts: number;
}
```

- [ ] **Step 3: Add useServers and useServer hooks**

Add at the bottom of `dashboard/src/hooks/useProjects.ts`. Import the types from the new types file:

```typescript
import type { ServersResponse, TrackedSession } from '../types';
```

Then add the hooks:

```typescript
export function useServers(): FetchState<ServersResponse> {
  return useFetch<ServersResponse>('/api/servers', 'servers');
}

export function useServer(name: string | null): FetchState<TrackedSession> {
  return useFetch<TrackedSession>(
    name ? `/api/servers/${encodeURIComponent(name)}` : null,
    'servers',
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/hooks/useProjects.ts dashboard/src/hooks/useWebSocket.ts dashboard/src/types.ts
git commit -m "feat(server-tracker): frontend data hooks for servers"
```

---

### Task 7: Servers Page

**Files:**
- Create: `dashboard/src/pages/ServersPage.tsx`
- Modify: `dashboard/src/App.tsx` (add route)
- Modify: `dashboard/src/components/AppShell.tsx:19-25` (add nav item)
- Modify: `dashboard/src/components/Layout.tsx` (add breadcrumb pattern)

- [ ] **Step 1: Create the ServersPage component**

Create `dashboard/src/pages/ServersPage.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Monitor,
  RefreshCw,
  Trash2,
  GitBranch,
  ExternalLink,
  LinkIcon,
  Plus,
  ServerOff,
  Terminal,
} from 'lucide-react';
import { useServers } from '../hooks/useProjects';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import type { TrackedSession, TrackedPane } from '../types';

export function ServersPage() {
  const { data, loading, error, refetch } = useServers();
  const [registering, setRegistering] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [refreshingAll, setRefreshingAll] = useState(false);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!newSessionName.trim()) return;
    try {
      await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newSessionName.trim() }),
      });
      setNewSessionName('');
      setRegistering(false);
      refetch();
    } catch {
      // Error handling — refetch will show current state
    }
  }

  async function handleRefreshAll() {
    setRefreshingAll(true);
    try {
      await fetch('/api/servers/refresh', { method: 'POST' });
      refetch();
    } finally {
      setRefreshingAll(false);
    }
  }

  async function handleRemove(name: string) {
    await fetch(`/api/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    refetch();
  }

  async function handleRefreshOne(name: string) {
    await fetch(`/api/servers/${encodeURIComponent(name)}/refresh`, { method: 'POST' });
    refetch();
  }

  if (loading) return <LoadingState label="Loading servers…" />;
  if (error) return <ErrorState error={error} />;
  if (!data) return null;

  if (!data.tmuxAvailable) {
    return (
      <>
        <PageHeader eyebrow="Infrastructure" title="Servers" />
        <div className="surface-panel mt-4 flex flex-col items-center gap-3 py-12 text-center">
          <Terminal className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm font-medium text-foreground">tmux is not installed</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Server tracking requires tmux. Install it with <code className="rounded bg-muted px-1.5 py-0.5 text-xs">brew install tmux</code> to get started.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Infrastructure"
        title="Servers"
        actions={
          <div className="flex items-center gap-2">
            {registering ? (
              <form onSubmit={handleRegister} className="flex items-center gap-2">
                <input
                  type="text"
                  value={newSessionName}
                  onChange={(e) => setNewSessionName(e.target.value)}
                  placeholder="tmux session name"
                  className="editor-input text-sm"
                  autoFocus
                />
                <button type="submit" className="shell-action">Add</button>
                <button type="button" className="shell-action" onClick={() => setRegistering(false)}>Cancel</button>
              </form>
            ) : (
              <button className="shell-action" onClick={() => setRegistering(true)}>
                <Plus className="h-3.5 w-3.5" />
                Track Session
              </button>
            )}
            <button
              className="shell-action"
              onClick={handleRefreshAll}
              disabled={refreshingAll}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? 'animate-spin' : ''}`} />
              Refresh All
            </button>
          </div>
        }
      />

      {data.sessions.length === 0 ? (
        <EmptyState
          title="No sessions tracked"
          description="Register a tmux session to start tracking your dev servers."
        />
      ) : (
        <div className="mt-4 space-y-4">
          {data.sessions.map((session) => (
            <SessionCard
              key={session.name}
              session={session}
              onRefresh={() => handleRefreshOne(session.name)}
              onRemove={() => handleRemove(session.name)}
              onRefetch={refetch}
            />
          ))}
        </div>
      )}
    </>
  );
}

function SessionCard({
  session,
  onRefresh,
  onRemove,
  onRefetch,
}: {
  session: TrackedSession;
  onRefresh: () => void;
  onRemove: () => void;
  onRefetch: () => void;
}) {
  return (
    <div className="surface-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">{session.name}</span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              session.alive
                ? 'border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
                : 'border border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-400'
            }`}
          >
            {session.alive ? 'alive' : 'dead'}
          </span>
          <span className="text-xs text-muted-foreground">
            Last refreshed: {new Date(session.lastRefreshed).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button className="shell-action" onClick={onRefresh} title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button className="shell-action" onClick={onRemove} title="Remove">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {session.alive && session.windows.length > 0 && (
        <div className="mt-3 space-y-3">
          {session.windows.map((win) => (
            <div key={win.index}>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Window {win.index}: {win.name}
              </p>
              <div className="space-y-1.5">
                {win.panes.map((pane) => (
                  <PaneRow
                    key={`${win.index}:${pane.index}`}
                    pane={pane}
                    sessionName={session.name}
                    windowIndex={win.index}
                    onRefetch={onRefetch}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!session.alive && (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <ServerOff className="h-4 w-4" />
          <span>tmux session no longer exists</span>
        </div>
      )}
    </div>
  );
}

function PaneRow({
  pane,
  sessionName,
  windowIndex,
  onRefetch,
}: {
  pane: TrackedPane;
  sessionName: string;
  windowIndex: number;
  onRefetch: () => void;
}) {
  // Shorten cwd for display
  const shortCwd = pane.cwd.replace(/^\/Users\/[^/]+/, '~');

  return (
    <div className="flex items-center gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2 text-sm">
      <span className="shrink-0 font-mono text-xs text-muted-foreground/60">:{pane.index}</span>
      <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{pane.command}</span>
      <span className="min-w-0 truncate text-xs text-muted-foreground" title={pane.cwd}>{shortCwd}</span>
      {pane.branch && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3" />
          {pane.branch}
          {pane.worktree && (
            <span className="rounded bg-violet-100 px-1 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-950/40 dark:text-violet-400">
              worktree
            </span>
          )}
        </span>
      )}
      {pane.ports.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5">
          {pane.urls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-xs font-medium text-teal-700 hover:bg-teal-100 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-400 dark:hover:bg-teal-950/60"
            >
              {url.replace('http://localhost:', ':')}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ))}
        </div>
      )}
      <div className="ml-auto shrink-0">
        {pane.assignment ? (
          <Link
            to={`/projects/${pane.assignment.project}/assignments/${pane.assignment.slug}`}
            className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/20"
          >
            <LinkIcon className="h-2.5 w-2.5" />
            {pane.assignment.title}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground/40">unlinked</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add route in App.tsx**

Import and add the route:

```tsx
import { ServersPage } from './pages/ServersPage';
```

Add route inside the Layout routes (after the `/help` route):
```tsx
<Route path="/servers" element={<ServersPage />} />
```

- [ ] **Step 3: Add nav item in AppShell.tsx**

Import `Monitor` icon and add to `NAV_ITEMS`:

```tsx
import { AlertTriangle, Compass, FolderKanban, LifeBuoy, ListTodo, Monitor, X } from 'lucide-react';

const NAV_ITEMS: SidebarNavItem[] = [
  { to: '/', label: 'Overview', icon: Compass },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/assignments', label: 'Assignments', icon: ListTodo },
  { to: '/servers', label: 'Servers', icon: Monitor },
  { to: '/attention', label: 'Attention', icon: AlertTriangle },
  { to: '/help', label: 'Help', icon: LifeBuoy },
];
```

- [ ] **Step 4: Add breadcrumb pattern in Layout.tsx**

In the `buildShellMeta` function, add a case for `/servers`:

```typescript
if (pathname === '/servers') {
  return { title: 'Servers', breadcrumbs: [{ label: 'Servers', path: '/servers' }], projectSlug: null };
}
```

- [ ] **Step 5: Build and verify dashboard compiles**

Run: `cd dashboard && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/pages/ServersPage.tsx dashboard/src/App.tsx dashboard/src/components/AppShell.tsx dashboard/src/components/Layout.tsx
git commit -m "feat(server-tracker): servers page with session cards, pane rows, and nav"
```

---

### Task 8: Contextual Integration (Overview, AssignmentDetail, Attention)

**Files:**
- Modify: `dashboard/src/pages/Overview.tsx` (add stat card)
- Modify: `dashboard/src/pages/AssignmentDetail.tsx` (add servers section)
- Modify: `src/dashboard/api.ts` (add server counts to overview, dead sessions to attention)

- [ ] **Step 1: Add server stats to overview API response**

In `src/dashboard/types.ts`, add `serverStats` to the `OverviewResponse` interface (find it and add the field):

```typescript
serverStats?: {
  trackedSessions: number;
  aliveSessions: number;
  deadSessions: number;
  totalPorts: number;
};
```

In `src/dashboard/api.ts`, update `getOverview()` to accept an optional `serversDir` parameter and include server stats. Add `serversDir` as an optional second parameter:

```typescript
export async function getOverview(projectsDir: string, serversDir?: string): Promise<OverviewResponse> {
  // ... existing code unchanged ...

  // At the end, before the return statement, add:
  let serverStats: OverviewResponse['serverStats'];
  if (serversDir) {
    try {
      const { scanAllSessions } = await import('./scanner.js');
      const servers = await scanAllSessions(serversDir, projectsDir);
      if (servers.tmuxAvailable) {
        const alive = servers.sessions.filter(s => s.alive).length;
        const totalPorts = servers.sessions.reduce((sum, s) =>
          sum + s.windows.reduce((ws, w) =>
            ws + w.panes.reduce((ps, p) => ps + p.ports.length, 0), 0), 0);
        serverStats = {
          trackedSessions: servers.sessions.length,
          aliveSessions: alive,
          deadSessions: servers.sessions.length - alive,
          totalPorts,
        };
      }
    } catch {
      // Server scanning failure should not break overview
    }
  }

  // Merge serverStats into the existing return object
  return { ...result, serverStats };
}
```

Update the call in `server.ts` to pass `serversDir` (the `getOverview` call, around line 74):
```typescript
const data = await getOverview(projectsDir, serversDir);
```

Also update the `getAttention` call in `server.ts` to pass `serversDir`:
```typescript
const data = await getAttention(projectsDir, serversDir);
```

- [ ] **Step 2: Add stat card to Overview page**

In `dashboard/src/pages/Overview.tsx`:

1. Add `Monitor` to the lucide-react import
2. The `OverviewResponse` type used by `useOverview()` is defined in `useProjects.ts`. Update that interface to include `serverStats?` matching the backend type. Find the `OverviewResponse` interface in `dashboard/src/hooks/useProjects.ts` and add:
```typescript
serverStats?: {
  trackedSessions: number;
  aliveSessions: number;
  deadSessions: number;
  totalPorts: number;
};
```
3. Add a stat card in the stat grid (after the existing 6 stat cards, inside the grid):

```tsx
{data.serverStats && (
  <Link to="/servers">
    <StatCard
      label="Active Servers"
      value={data.serverStats.aliveSessions}
      description={`${data.serverStats.totalPorts} ports · ${data.serverStats.deadSessions > 0 ? `${data.serverStats.deadSessions} dead` : 'all healthy'}`}
      icon={Monitor}
      tone={data.serverStats.deadSessions > 0 ? 'warn' : 'default'}
    />
  </Link>
)}
```

- [ ] **Step 3: Add servers section to AssignmentDetail page**

In `dashboard/src/pages/AssignmentDetail.tsx`:

1. Add `ExternalLink` to the lucide-react import
2. Add `import { useServers } from '../hooks/useProjects';`
3. Add `import { SectionCard } from '../components/SectionCard';` if not already imported
4. Inside the component function, add the servers data fetch and linked panes computation:

```tsx
// At top of component:
const { data: serversData } = useServers();

// Compute linked panes for this assignment
const linkedPanes: Array<{ sessionName: string; command: string; urls: string[] }> = [];
if (serversData?.sessions) {
  for (const session of serversData.sessions) {
    for (const win of session.windows) {
      for (const pane of win.panes) {
        if (pane.assignment?.project === slug && pane.assignment?.slug === aslug) {
          linkedPanes.push({
            sessionName: session.name,
            command: pane.command,
            urls: pane.urls,
          });
        }
      }
    }
  }
}
```

Then in the sidebar, after the Workspace Info section:

```tsx
{linkedPanes.length > 0 && (
  <SectionCard title="Servers">
    <div className="space-y-2">
      {linkedPanes.map((lp, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{lp.command}</span>
          <span className="text-xs text-muted-foreground">{lp.sessionName}</span>
          {lp.urls.map(url => (
            <a key={url} href={url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-teal-600 hover:underline dark:text-teal-400">
              {url.replace('http://localhost:', ':')}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ))}
        </div>
      ))}
    </div>
  </SectionCard>
)}
```

- [ ] **Step 4: Add dead sessions to attention API**

In `src/dashboard/api.ts`, update `getAttention()` to accept optional `serversDir` as a second parameter. After calling `buildAttentionItems()` and before the return, add dead session scanning. The items must conform to `AttentionItem` interface (from `types.ts` lines 140-153):

```typescript
export async function getAttention(projectsDir: string, serversDir?: string): Promise<AttentionResponse> {
  // ... existing code that calls buildAttentionItems ...
  // items is the array from buildAttentionItems

  // After building items, before sorting/slicing:
  if (serversDir) {
    try {
      const { scanAllSessions } = await import('./scanner.js');
      const servers = await scanAllSessions(serversDir, projectsDir);
      for (const session of servers.sessions) {
        if (!session.alive) {
          items.push({
            id: `server-dead-${session.name}`,
            severity: 'low',
            projectSlug: '',
            projectTitle: '',
            assignmentSlug: '',
            assignmentTitle: `tmux: ${session.name}`,
            status: 'failed' as AssignmentStatus,
            reason: 'Tmux session no longer exists but is still registered',
            updated: session.lastRefreshed,
            href: '/servers',
            stale: false,
            blockedReason: null,
          });
        }
      }
    } catch {
      // Server scanning failure should not break attention
    }
  }

  // ... rest of existing code (sorting, slicing, building summary) ...
}
```

Note: Uses `'failed'` as the status since there's no 'dead' in `AssignmentStatus`. The `href` points to `/servers` instead of an assignment page.

- [ ] **Step 5: Build and verify**

Run: `npx vitest run && cd dashboard && npx tsc --noEmit`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/api.ts src/dashboard/types.ts src/dashboard/server.ts dashboard/src/pages/Overview.tsx dashboard/src/pages/AssignmentDetail.tsx
git commit -m "feat(server-tracker): contextual integration on overview, assignment detail, and attention"
```

---

### Task 9: Plugin Slash Command

**Files:**
- Create: `plugin/commands/track-session/track-session.md`

- [ ] **Step 1: Create the plugin slash command**

Create directory and file `plugin/commands/track-session/track-session.md`:

```markdown
---
name: track-session
description: Register, refresh, or remove a tmux session for server tracking in the Syntaur dashboard
arguments:
  - name: session
    description: "Tmux session name to track (or --refresh/--remove/--list flags)"
    required: false
---

# /track-session

Track a tmux session so its dev servers appear in the Syntaur dashboard.

## Usage

- `/track-session <session-name>` — Register a session and scan it
- `/track-session --refresh [session-name]` — Refresh one or all sessions
- `/track-session --remove <session-name>` — Stop tracking a session
- `/track-session --list` — List all tracked sessions

## Instructions

When the user runs this command, follow these steps based on the argument:

### Register (default — argument is a session name)

1. Verify the tmux session exists: run `tmux has-session -t <name>` via Bash
2. If it doesn't exist, tell the user and list available sessions with `tmux list-sessions -F '#{session_name}'`
3. Create the registration file at `~/.syntaur/servers/<sanitized-name>.md`:
   - Sanitize the name: replace any character that isn't alphanumeric, hyphen, or underscore with a hyphen
   - Write this content:
   ```
   ---
   session: <original-name>
   registered: <ISO timestamp>
   last_refreshed: <ISO timestamp>
   ---
   ```
4. Tell the user the session is now tracked and they can view it at the `/servers` page in the dashboard

### --refresh [session-name]

1. If a session name is given, update its `last_refreshed` timestamp in `~/.syntaur/servers/<name>.md`
2. If no session name, update all `.md` files in `~/.syntaur/servers/`
3. Tell the user to check the dashboard for updated scan data

### --remove <session-name>

1. Delete the file `~/.syntaur/servers/<sanitized-name>.md`
2. Confirm removal to the user

### --list

1. List all `.md` files in `~/.syntaur/servers/`
2. For each, read the `session` field from frontmatter and display it
3. If none exist, tell the user no sessions are being tracked
```

- [ ] **Step 2: Commit**

```bash
git add plugin/commands/track-session/
git commit -m "feat(server-tracker): /track-session plugin slash command"
```

---

### Task 10: End-to-End Verification

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Build the project**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Build the dashboard**

Run: `npm run build:dashboard`
Expected: Clean build, no errors

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck && cd dashboard && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Manual smoke test**

1. Start the dashboard: `npx syntaur dashboard --dev`
2. Open the dashboard, verify "Servers" appears in sidebar
3. Click "Servers" page — should show empty state or tmux-not-installed if no tmux
4. If tmux is available, create a test session: `tmux new-session -d -s test-stack`
5. In the dashboard, click "Track Session", enter "test-stack", verify it appears
6. Click "Refresh All", verify scan data populates
7. Click "Remove" to clean up
8. Kill the tmux session: `tmux kill-session -t test-stack`

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(server-tracker): address issues found during e2e verification"
```
