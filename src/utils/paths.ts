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

export function projectTodosDir(projectsDir: string, projectSlug: string): string {
  return resolve(projectsDir, projectSlug, 'todos');
}

export function todoPlanDir(todosDir: string, workspaceOrProject: string, todoId: string): string {
  return resolve(todosDir, 'plans', workspaceOrProject, todoId);
}
