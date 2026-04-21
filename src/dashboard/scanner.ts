import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { realpath, readdir, readFile } from 'node:fs/promises';
import { listProjects } from './api.js';
import {
  readSessionFile,
  listSessionFiles,
} from './servers.js';
import { extractFrontmatter, getField, getNestedField } from './parser.js';
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

export async function execQuiet(cmd: string, args: string[]): Promise<string> {
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

export async function sessionAlive(name: string): Promise<boolean> {
  try {
    await exec('tmux', ['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

export async function listTmuxPanes(sessionName: string): Promise<RawPane[]> {
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

export async function getLsofOutput(): Promise<string> {
  return execQuiet('lsof', ['-i', '-P', '-n', '-sTCP:LISTEN']);
}

export async function getGitInfo(cwd: string): Promise<{ branch: string | null; worktree: boolean }> {
  const branch = await execQuiet('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return { branch: null, worktree: false };

  const commonDir = await execQuiet('git', ['-C', cwd, 'rev-parse', '--git-common-dir']);
  const gitDir = await execQuiet('git', ['-C', cwd, 'rev-parse', '--git-dir']);

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

export interface AssignmentLink {
  project: string | null;
  slug: string;
  title: string;
}

export interface WorkspaceRecord {
  projectSlug: string | null;
  /** For project-nested, the slug. For standalone, the UUID. */
  assignmentSlug: string;
  assignmentTitle: string;
  worktreePath: string | null;
  branch: string | null;
}

export async function loadWorkspaceRecords(
  projectsDir: string,
  assignmentsDir?: string,
): Promise<WorkspaceRecord[]> {
  const records: WorkspaceRecord[] = [];
  try {
    const projects = await listProjects(projectsDir);

    for (const project of projects) {
      const projectAssignmentsDir = resolve(projectsDir, project.slug, 'assignments');
      let slugs: string[];
      try {
        slugs = await readdir(projectAssignmentsDir);
      } catch {
        continue;
      }
      for (const aslug of slugs) {
        const aFile = resolve(projectAssignmentsDir, aslug, 'assignment.md');
        try {
          const raw = await readFile(aFile, 'utf-8');
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

  if (assignmentsDir) {
    try {
      const entries = await readdir(assignmentsDir);
      for (const id of entries) {
        if (id.startsWith('.') || id.startsWith('_')) continue;
        const aFile = resolve(assignmentsDir, id, 'assignment.md');
        try {
          const raw = await readFile(aFile, 'utf-8');
          const [fm] = extractFrontmatter(raw);
          if (!fm) continue;
          records.push({
            projectSlug: null,
            assignmentSlug: id,
            assignmentTitle: getField(fm, 'title') ?? id,
            worktreePath: getNestedField(fm, 'workspace', 'worktreePath') ?? null,
            branch: getNestedField(fm, 'workspace', 'branch') ?? null,
          });
        } catch {
          continue;
        }
      }
    } catch {
      // standalone dir missing is fine
    }
  }

  return records;
}

export async function resolveAndNormalize(p: string): Promise<string> {
  try {
    const resolved = await realpath(p);
    return resolved.replace(/\/+$/, '');
  } catch {
    return p.replace(/\/+$/, '');
  }
}

export async function autoLinkPane(
  cwd: string,
  branch: string | null,
  records: WorkspaceRecord[],
): Promise<AssignmentLink | null> {
  const normalizedCwd = await resolveAndNormalize(cwd);
  for (const rec of records) {
    if (rec.worktreePath) {
      const normalizedWt = await resolveAndNormalize(rec.worktreePath);
      if (normalizedCwd === normalizedWt) {
        return { project: rec.projectSlug, slug: rec.assignmentSlug, title: rec.assignmentTitle };
      }
    }
  }
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
      kind: 'tmux',
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

  // Build windows — use for-of loop, NOT .map() with async callback
  const windows: TrackedWindow[] = [];
  for (const [windowIndex, { name, panes: rawPanesInWindow }] of windowMap) {
    const panes: TrackedPane[] = [];
    for (const rp of rawPanesInWindow) {
      const key = `${rp.windowIndex}:${rp.paneIndex}`;
      const gitInfo = gitInfoCache.get(rp.cwd) ?? { branch: null, worktree: false };
      const ports = panePorts.get(key) ?? [];
      const urls = ports.map((p) => `http://localhost:${p}`);

      const override = sessionData.overrides[key];
      let assignment: AssignmentLink | null = null;
      if (override) {
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

      panes.push({
        index: rp.paneIndex,
        command: rp.command,
        cwd: rp.cwd,
        branch: gitInfo.branch,
        worktree: gitInfo.worktree,
        ports,
        urls,
        assignment,
      });
    }

    windows.push({ index: windowIndex, name, panes });
  }

  windows.sort((a, b) => a.index - b.index);

  return {
    name: sessionData.session,
    kind: 'tmux' as const,
    registered: sessionData.registered,
    lastRefreshed: sessionData.lastRefreshed,
    scannedAt: now,
    alive: true,
    windows,
  };
}

async function scanProcessSession(
  sessionData: SessionFileData,
  lsofOutput: string,
  workspaceRecords: WorkspaceRecord[],
): Promise<TrackedSession> {
  const now = new Date().toISOString();

  // Check if the process is still alive
  let alive = false;
  if (sessionData.pid) {
    try {
      process.kill(sessionData.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }

  if (!alive || !sessionData.cwd) {
    return {
      name: sessionData.session,
      kind: 'process',
      registered: sessionData.registered,
      lastRefreshed: sessionData.lastRefreshed,
      scannedAt: now,
      alive: false,
      windows: [],
    };
  }

  // Re-resolve ports from lsof for the PID
  const ports = findListeningPorts(lsofOutput, new Set([sessionData.pid!]));

  const gitInfo = await getGitInfo(sessionData.cwd);

  // Honor manual overrides (process sessions use key "0:0")
  const override = sessionData.overrides['0:0'];
  let assignment: AssignmentLink | null = null;
  if (override) {
    const rec = workspaceRecords.find(
      (r) => r.projectSlug === override.project && r.assignmentSlug === override.assignment,
    );
    assignment = {
      project: override.project,
      slug: override.assignment,
      title: rec?.assignmentTitle ?? override.assignment,
    };
  } else {
    assignment = await autoLinkPane(sessionData.cwd, gitInfo.branch, workspaceRecords);
  }

  const pane: TrackedPane = {
    index: 0,
    command: sessionData.session,
    cwd: sessionData.cwd,
    branch: gitInfo.branch,
    worktree: gitInfo.worktree,
    ports,
    urls: ports.map((p) => `http://localhost:${p}`),
    assignment,
  };

  return {
    name: sessionData.session,
    kind: 'process' as const,
    registered: sessionData.registered,
    lastRefreshed: sessionData.lastRefreshed,
    scannedAt: now,
    alive: true,
    windows: [{ index: 0, name: 'process', panes: [pane] }],
  };
}

export async function scanAllSessions(
  serversDir: string,
  projectsDir: string,
  options?: { bypassCache?: boolean; assignmentsDir?: string },
): Promise<ServersResponse> {
  if (!options?.bypassCache && cache && Date.now() < cache.expiry) {
    return cache.data;
  }

  const tmuxAvailable = await checkTmuxAvailable();
  const names = await listSessionFiles(serversDir);
  const lsofOutput = await getLsofOutput();
  const workspaceRecords = await loadWorkspaceRecords(projectsDir, options?.assignmentsDir);

  const sessions: TrackedSession[] = [];
  for (const name of names) {
    const data = await readSessionFile(serversDir, name);
    if (!data) continue;

    if (data.kind === 'process') {
      sessions.push(await scanProcessSession(data, lsofOutput, workspaceRecords));
    } else if (tmuxAvailable) {
      sessions.push(await scanSession(data, lsofOutput, workspaceRecords));
    }
    // Skip tmux-kind entries when tmux is unavailable
  }

  const result: ServersResponse = { sessions, tmuxAvailable };
  cache = { data: result, expiry: Date.now() + CACHE_TTL_MS };
  return result;
}

export async function scanSingleSession(
  serversDir: string,
  projectsDir: string,
  name: string,
  options?: { assignmentsDir?: string },
): Promise<TrackedSession | null> {
  const data = await readSessionFile(serversDir, name);
  if (!data) return null;

  const lsofOutput = await getLsofOutput();
  const workspaceRecords = await loadWorkspaceRecords(projectsDir, options?.assignmentsDir);

  if (data.kind === 'process') {
    return scanProcessSession(data, lsofOutput, workspaceRecords);
  }
  return scanSession(data, lsofOutput, workspaceRecords);
}
