import { resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'structure';

const KNOWN_TOP_LEVEL = new Set<string>([
  'missions',
  'playbooks',
  'todos',
  'servers',
  'config.md',
  'syntaur.db',
  'syntaur.db-shm',
  'syntaur.db-wal',
  'dashboard-port',
  'workspaces.json',
]);

const missionsDir: Check = {
  id: 'structure.missions-dir',
  category: CATEGORY,
  title: 'missions/ directory exists',
  async run(ctx) {
    const p = resolve(ctx.syntaurRoot, 'missions');
    if (!(await fileExists(p))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: 'missions/ missing under ~/.syntaur/',
        affected: [p],
        remediation: {
          kind: 'manual',
          suggestion: 'Run `syntaur init` to restore the standard layout',
          command: 'syntaur init',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this);
  },
};

const playbooksDir: Check = {
  id: 'structure.playbooks-dir',
  category: CATEGORY,
  title: 'playbooks/ directory exists',
  async run(ctx) {
    const p = resolve(ctx.syntaurRoot, 'playbooks');
    if (!(await fileExists(p))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: 'playbooks/ missing under ~/.syntaur/',
        affected: [p],
        remediation: {
          kind: 'manual',
          suggestion: 'Run `syntaur init` to restore the standard layout',
          command: 'syntaur init',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this);
  },
};

const todosDirValid: Check = {
  id: 'structure.todos-dir-valid',
  category: CATEGORY,
  title: 'todos/ directory is readable (if present)',
  async run(ctx) {
    const p = resolve(ctx.syntaurRoot, 'todos');
    if (!(await fileExists(p))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'todos/ not present (created lazily on first use)',
        autoFixable: false,
      } satisfies CheckResult;
    }
    const s = await stat(p);
    if (!s.isDirectory()) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: 'todos/ exists but is not a directory',
        affected: [p],
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this);
  },
};

const serversDirValid: Check = {
  id: 'structure.servers-dir-valid',
  category: CATEGORY,
  title: 'servers/ directory is readable (if present)',
  async run(ctx) {
    const p = resolve(ctx.syntaurRoot, 'servers');
    if (!(await fileExists(p))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'servers/ not present',
        autoFixable: false,
      } satisfies CheckResult;
    }
    const s = await stat(p);
    if (!s.isDirectory()) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: 'servers/ exists but is not a directory',
        affected: [p],
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this);
  },
};

const knownFilesRecognized: Check = {
  id: 'structure.known-files-recognized',
  category: CATEGORY,
  title: 'No unexpected top-level entries under ~/.syntaur/',
  async run(ctx) {
    const entries = await readdir(ctx.syntaurRoot, { withFileTypes: true });
    const unexpected: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (KNOWN_TOP_LEVEL.has(e.name)) continue;
      unexpected.push(e.name);
    }
    if (unexpected.length === 0) return pass(this);
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'warn',
      detail: `unexpected top-level entries: ${unexpected.join(', ')}`,
      affected: unexpected.map((n) => resolve(ctx.syntaurRoot, n)),
      remediation: {
        kind: 'manual',
        suggestion: 'Review these entries — they may be leftover state from older versions',
        command: null,
      },
      autoFixable: false,
    } satisfies CheckResult;
  },
};

export const structureChecks: Check[] = [
  missionsDir,
  playbooksDir,
  todosDirValid,
  serversDirValid,
  knownFilesRecognized,
];

function pass(check: { id: string; category: string; title: string }): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'pass',
    autoFixable: false,
  };
}
