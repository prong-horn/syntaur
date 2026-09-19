import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileExists } from '../../fs.js';
import {
  BUILTIN_TEMPLATE_IDS,
  builtinStatus,
} from '../../../ticket-templates/builtins.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'structure';

/** Top-level names the code may write directly under the Syntaur home. */
export const KNOWN_TOP_LEVEL = new Set<string>([
  'agents', // agents.ts
  'config.md', // config.ts
  'dashboard-port', // server.ts
  'inbox-snoozes.json', // snooze.ts
  'npx-handler-nudge', // install-detection.ts
  'npx-install.json', // npx-prompt.ts
  'playbooks', // paths.ts
  'projects', // paths.ts
  'templates', // ticket-templates/builtins.ts
  'runtime', // session-id.ts
  'v2-migrated', // migrate-v2.ts
  'statusline.backup.json', // install-statusline.ts
  'statusline.conf', // install-statusline.ts
  'statusline.config.json', // configure-statusline.ts
  'statusline.sh', // install-statusline.ts
  'statusline-wrapped.sh', // install-statusline.ts
  'hooks', // hooks install
  'hooks.backup.json', // hooks install
  'syntaur.db', // events-db.ts
  'syntaur.db-shm', // sqlite WAL
  'syntaur.db-wal', // sqlite WAL
  'view-prefs.json', // paths.ts
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

const templatesDir: Check = {
  id: 'structure.templates-dir',
  category: CATEGORY,
  title: 'templates/ directory and built-in templates',
  async run(ctx) {
    const p = resolve(ctx.syntaurRoot, 'templates');
    if (!(await fileExists(p))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: 'templates/ missing under ~/.syntaur/',
        affected: [p],
        remediation: {
          kind: 'manual',
          suggestion: 'Run `syntaur init` or `syntaur template reset --missing` to seed built-in templates',
          command: 'syntaur template reset --missing',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    const problems: string[] = [];
    for (const id of BUILTIN_TEMPLATE_IDS) {
      const status = await builtinStatus(ctx.syntaurRoot, id);
      if (status === 'missing') problems.push(`${id}: missing`);
      else if (status === 'modified') problems.push(`${id}: modified`);
      else if (status === 'outdated') problems.push(`${id}: outdated`);
    }

    if (problems.length === 0) return pass(this);

    const command =
      problems.some((p) => p.includes('missing'))
        ? 'syntaur template reset --missing'
        : 'syntaur template reset <id>';

    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'warn',
      detail: `built-in template issues: ${problems.join('; ')}`,
      affected: problems.map((n) => resolve(p, n.split(':')[0])),
      remediation: {
        kind: 'manual',
        suggestion: 'Run `syntaur template check --builtins` for details, then reset as needed',
        command,
      },
      autoFixable: false,
    } satisfies CheckResult;
  },
};

export const structureChecks: Check[] = [
  projectsDir,
  playbooksDir,
  templatesDir,
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
