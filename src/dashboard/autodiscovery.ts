import {
  execQuiet,
  checkTmuxAvailable,
  sessionAlive,
  listTmuxPanes,
  getLsofOutput,
  loadWorkspaceRecords,
  autoLinkPane,
  getGitInfo,
  clearScanCache,
} from './scanner.js';
import {
  readSessionFile,
  listSessionFiles,
  registerAutoSession,
  removeSession,
  sanitizeSessionName,
} from './servers.js';
import type { SessionFileData } from './types.js';

// --- Shared lsof helpers ---

export function parsePortsForPid(lsofOutput: string, targetPid: number): number[] {
  const ports: number[] = [];
  for (const line of lsofOutput.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = parseInt(parts[1], 10);
    if (pid !== targetPid) continue;
    const tcpAddr = parts.find((p) => p.includes(':') && /:\d+$/.test(p));
    if (tcpAddr) {
      const port = parseInt(tcpAddr.split(':').pop()!, 10);
      if (!isNaN(port) && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
}

export function parseLsofForListeningProcesses(lsofOutput: string): ListeningProcess[] {
  const seen = new Map<number, ListeningProcess>();
  for (const line of lsofOutput.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const command = parts[0];
    const pid = parseInt(parts[1], 10);
    if (isNaN(pid)) continue;
    const tcpAddr = parts.find((p) => p.includes(':') && /:\d+$/.test(p));
    if (!tcpAddr) continue;
    const port = parseInt(tcpAddr.split(':').pop()!, 10);
    if (isNaN(port)) continue;

    if (!seen.has(pid)) {
      seen.set(pid, { pid, port, command });
    }
  }
  return Array.from(seen.values());
}

// --- Singleton lifecycle ---

let timer: ReturnType<typeof setInterval> | null = null;
let activeReconcile: Promise<void> | null = null;

export interface AutodiscoveryOptions {
  serversDir: string;
  projectsDir: string;
  intervalMs?: number;
  excludePids?: Set<number>;
}

let savedOptions: AutodiscoveryOptions | null = null;

export function startAutodiscovery(opts: AutodiscoveryOptions): void {
  if (timer) return;
  savedOptions = opts;
  const interval = opts.intervalMs ?? 45_000;
  // Run once immediately, then on interval
  runReconcile();
  timer = setInterval(() => {
    runReconcile();
  }, interval);
}

export async function stopAutodiscovery(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Await in-flight reconcile to prevent overlap
  if (activeReconcile) {
    await activeReconcile;
    activeReconcile = null;
  }
  savedOptions = null;
}

function runReconcile(): void {
  if (activeReconcile || !savedOptions) return;
  const opts = savedOptions;
  activeReconcile = reconcile(opts.serversDir, opts.projectsDir, opts.excludePids)
    .catch((err) => {
      console.error('[autodiscovery] reconcile failed:', err);
    })
    .finally(() => {
      activeReconcile = null;
    });
}

// --- Tmux discovery ---

export async function listAllTmuxSessions(): Promise<string[]> {
  const output = await execQuiet('tmux', ['list-sessions', '-F', '#{session_name}']);
  if (!output) return [];
  return output.split('\n').filter((line) => line.length > 0);
}

async function discoverTmuxSessions(
  serversDir: string,
  projectsDir: string,
  existingNames: Set<string>,
): Promise<boolean> {
  const tmuxAvailable = await checkTmuxAvailable();
  if (!tmuxAvailable) return false;

  const workspaceRecords = await loadWorkspaceRecords(projectsDir);
  if (workspaceRecords.length === 0) return false;

  const sessions = await listAllTmuxSessions();
  let changed = false;

  for (const sessionName of sessions) {
    const sanitized = sanitizeSessionName(sessionName);
    if (existingNames.has(sanitized)) {
      // Already tracked (manual or auto) — skip
      continue;
    }

    const panes = await listTmuxPanes(sessionName);
    if (panes.length === 0) continue;

    // Check if any pane matches a workspace
    let matched = false;
    const cwdGitCache = new Map<string, { branch: string | null; worktree: boolean }>();

    for (const pane of panes) {
      if (!cwdGitCache.has(pane.cwd)) {
        cwdGitCache.set(pane.cwd, await getGitInfo(pane.cwd));
      }
      const gitInfo = cwdGitCache.get(pane.cwd)!;
      const link = await autoLinkPane(pane.cwd, gitInfo.branch, workspaceRecords);
      if (link) {
        matched = true;
        break;
      }
    }

    if (matched) {
      await registerAutoSession(serversDir, sessionName, { kind: 'tmux' });
      changed = true;
    }
  }

  return changed;
}

// --- Non-tmux process discovery ---

interface ListeningProcess {
  pid: number;
  port: number;
  command: string;
}

async function getProcessCwd(pid: number): Promise<string | null> {
  // macOS: use lsof to get cwd
  const output = await execQuiet('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn']);
  if (!output) return null;
  // Output format: lines starting with 'n' contain the path
  for (const line of output.split('\n')) {
    if (line.startsWith('n') && line.length > 1) {
      return line.slice(1);
    }
  }
  return null;
}

async function discoverProcesses(
  serversDir: string,
  projectsDir: string,
  existingFiles: Map<string, SessionFileData>,
  excludePids?: Set<number>,
): Promise<boolean> {
  const workspaceRecords = await loadWorkspaceRecords(projectsDir);
  if (workspaceRecords.length === 0) return false;

  const lsofOutput = await getLsofOutput();
  if (!lsofOutput) return false;

  const processes = parseLsofForListeningProcesses(lsofOutput);
  let changed = false;

  // Track which PIDs are already tracked by existing process-kind entries
  const trackedPids = new Set<number>();
  for (const data of existingFiles.values()) {
    if (data.kind === 'process' && data.pid) {
      trackedPids.add(data.pid);
    }
  }

  for (const proc of processes) {
    if (trackedPids.has(proc.pid)) continue;
    if (excludePids?.has(proc.pid)) continue;

    const cwd = await getProcessCwd(proc.pid);
    if (!cwd) continue;

    const gitInfo = await getGitInfo(cwd);
    const link = await autoLinkPane(cwd, gitInfo.branch, workspaceRecords);
    if (!link) continue;

    // Build a session name from the command and port
    const sessionName = `proc-${proc.command}-${proc.port}`;
    const sanitized = sanitizeSessionName(sessionName);

    // Skip if already registered under this name
    if (existingFiles.has(sanitized)) continue;

    const ports = parsePortsForPid(lsofOutput, proc.pid);
    await registerAutoSession(serversDir, sessionName, {
      kind: 'process',
      pid: proc.pid,
      ports: ports.length > 0 ? ports : [proc.port],
      cwd,
    });
    changed = true;
  }

  return changed;
}

// --- Reconciliation ---

async function cleanupDeadAutoSessions(
  serversDir: string,
  existingFiles: Map<string, SessionFileData>,
): Promise<{ changed: boolean; removedNames: Set<string> }> {
  let changed = false;
  const removedNames = new Set<string>();

  // Only check tmux liveness if tmux is available
  const tmuxAvailable = await checkTmuxAvailable();

  for (const [name, data] of existingFiles) {
    if (!data.auto) continue;

    let alive = true; // Default to alive for unknown kinds
    if (data.kind === 'tmux') {
      if (!tmuxAvailable) continue; // Don't delete tmux sessions when tmux is unavailable
      alive = await sessionAlive(data.session);
    } else if (data.kind === 'process' && data.pid) {
      alive = await isProcessAlive(data.pid);
    } else {
      // Unknown kind with auto: true — leave it alone
      continue;
    }

    if (!alive) {
      await removeSession(serversDir, name);
      removedNames.add(name);
      changed = true;
    }
  }

  return { changed, removedNames };
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reconcile(serversDir: string, projectsDir: string, excludePids?: Set<number>): Promise<void> {
  // Load all existing session files
  const names = await listSessionFiles(serversDir);
  const existingFiles = new Map<string, SessionFileData>();
  for (const name of names) {
    const data = await readSessionFile(serversDir, name);
    if (data) existingFiles.set(name, data);
  }

  // Clean up dead auto sessions FIRST so discovery can re-register restarted processes
  const { changed: cleanupChanged, removedNames } = await cleanupDeadAutoSessions(serversDir, existingFiles);

  // Remove cleaned-up entries from the maps so discovery sees them as available
  for (const name of removedNames) {
    existingFiles.delete(name);
  }
  const existingNames = new Set(existingFiles.keys());

  // Discover new sessions
  const tmuxChanged = await discoverTmuxSessions(serversDir, projectsDir, existingNames);
  const processChanged = await discoverProcesses(serversDir, projectsDir, existingFiles, excludePids);

  // Invalidate scan cache if anything changed
  if (tmuxChanged || processChanged || cleanupChanged) {
    clearScanCache();
  }
}

// --- Exports for testing ---
export { reconcile, getProcessCwd };
