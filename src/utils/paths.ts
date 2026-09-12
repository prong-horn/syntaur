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

export function ticketsDir(): string {
  return resolve(syntaurRoot(), 'tickets');
}

/** @deprecated Dashboard compat until Task 2 — standalone tree is now under tickets/ */
export const assignmentsDir = ticketsDir;

export function playbooksDir(): string {
  return resolve(syntaurRoot(), 'playbooks');
}

export function workflowsDir(): string {
  return resolve(syntaurRoot(), 'workflows');
}

export function viewPrefsFile(): string {
  return resolve(syntaurRoot(), 'view-prefs.json');
}
