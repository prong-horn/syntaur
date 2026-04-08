import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

export function syntaurRoot(): string {
  return resolve(homedir(), '.syntaur');
}

export function defaultMissionDir(): string {
  return resolve(syntaurRoot(), 'missions');
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
