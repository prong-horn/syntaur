import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

export function syntaurRoot(): string {
  const override = process.env.SYNTAUR_HOME;
  if (override && override.length > 0) {
    return resolve(expandHome(override));
  }
  return resolve(homedir(), '.syntaur');
}

export function defaultProjectDir(): string {
  return resolve(syntaurRoot(), 'projects');
}

export function assignmentsDir(): string {
  return resolve(syntaurRoot(), 'assignments');
}

export function serversDir(): string {
  return resolve(syntaurRoot(), 'servers');
}

export function playbooksDir(): string {
  return resolve(syntaurRoot(), 'playbooks');
}

export function todosDir(): string {
  return resolve(syntaurRoot(), 'todos');
}

export function viewPrefsFile(): string {
  return resolve(syntaurRoot(), 'view-prefs.json');
}

export function projectTodosDir(projectsDir: string, projectSlug: string): string {
  return resolve(projectsDir, projectSlug, 'todos');
}

export function todoPlanDir(todosDir: string, workspaceOrProject: string, todoId: string): string {
  return resolve(todosDir, 'plans', workspaceOrProject, todoId);
}

// Bundle plan files live under `plans/<scopeOrProject>/bundles/<bundleId>/`,
// keeping them disjoint from todo plans (which omit the `bundles/` segment).
export function bundlePlanDir(todosDir: string, scopeOrProject: string, bundleId: string): string {
  return resolve(todosDir, 'plans', scopeOrProject, 'bundles', bundleId);
}

// Bundle storage lives under a `bundles/` subdirectory so the workspace-checklist
// discovery glob (which scans top-level *.md files in todosDir) does not pick it up.
export function bundlesDir(todosDir: string): string {
  return resolve(todosDir, 'bundles');
}

export function bundlesPath(todosDir: string): string {
  return resolve(todosDir, 'bundles', 'index.md');
}

export function proofDir(assignmentDir: string): string {
  return resolve(assignmentDir, 'proof');
}
