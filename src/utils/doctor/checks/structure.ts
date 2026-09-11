import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'structure';

/** Top-level names the code may write directly under the Syntaur home. */
export const KNOWN_TOP_LEVEL = new Set<string>([
  'agents', // agents.ts
  'assignments', // paths.ts
  'config.md', // config.ts
  'dashboard-port', // server.ts
  'derive-migrated', // recompute.ts
  'inbox-snoozes.json', // snooze.ts
  'npx-handler-nudge', // install-detection.ts
  'npx-install.json', // npx-prompt.ts
  'playbooks', // paths.ts
  'projects', // paths.ts
  'runtime', // session-id.ts
  'stages-migrated', // stages-marker.ts
  'statusline.backup.json', // install-statusline.ts
  'statusline.conf', // install-statusline.ts
  'statusline.config.json', // configure-statusline.ts
  'statusline.sh', // install-statusline.ts
  'statusline-wrapped.sh', // install-statusline.ts
  'syntaur.db', // events-db.ts
  'syntaur.db-shm', // sqlite WAL
  'syntaur.db-wal', // sqlite WAL
  'targets', // user-descriptors.ts
  'tier3-violations.log', // hermes plugin write-boundary violations (platforms/hermes)
  'view-prefs.json', // paths.ts
  'workflows', // paths.ts
  'worktrees', // worktree-defaults.ts
]);

const projectsDir: Check = {
  id: 'structure.projects-dir',
  category: CATEGORY,
  title: 'projects/ directory exists',
  async run(ctx) {
    const p = resolve(ctx.syntaurRoot, 'projects');
    if (!(await fileExists(p))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: 'projects/ missing under ~/.syntaur/',
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
  projectsDir,
  playbooksDir,
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
