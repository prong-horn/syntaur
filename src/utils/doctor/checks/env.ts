import { resolve, isAbsolute } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fileExists } from '../../fs.js';
import { expandHome } from '../../paths.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'env';

const syntaurRootExists: Check = {
  id: 'env.syntaur-root-exists',
  category: CATEGORY,
  title: '~/.syntaur/ directory exists',
  async run(ctx) {
    try {
      const s = await stat(ctx.syntaurRoot);
      if (!s.isDirectory()) {
        return err(this, `${ctx.syntaurRoot} exists but is not a directory`, [
          ctx.syntaurRoot,
        ]);
      }
      return pass(this);
    } catch {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `${ctx.syntaurRoot} does not exist — run 'syntaur init'`,
        affected: [ctx.syntaurRoot],
        remediation: {
          kind: 'manual',
          suggestion: 'Run `syntaur init` to create the Syntaur directory',
          command: 'syntaur init',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
  },
};

const configValid: Check = {
  id: 'env.config-valid',
  category: CATEGORY,
  title: '~/.syntaur/config.md is valid',
  async run(ctx) {
    const configPath = resolve(ctx.syntaurRoot, 'config.md');
    if (!(await fileExists(configPath))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: 'config.md not found; defaults are in use',
        affected: [configPath],
        remediation: {
          kind: 'manual',
          suggestion: 'Run `syntaur init` to regenerate config.md',
          command: 'syntaur init',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    const content = await readFile(configPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch || fmMatch[1].trim() === '') {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: 'config.md has missing or empty frontmatter — readConfig() silently fell back to defaults',
        affected: [configPath],
        remediation: {
          kind: 'manual',
          suggestion: 'Restore config.md from backup or re-run `syntaur init --force`',
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    const fmBlock = fmMatch[1];

    const rawProjectDir = readTopLevelField(fmBlock, 'defaultProjectDir');
    if (rawProjectDir === null) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: 'config.md frontmatter is missing required field `defaultProjectDir`',
        affected: [configPath],
        remediation: {
          kind: 'manual',
          suggestion: 'Add `defaultProjectDir: <absolute-path>` to the frontmatter or re-run `syntaur init --force`',
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    const expanded = expandHome(rawProjectDir);
    if (!isAbsolute(expanded)) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `config.md defaultProjectDir "${rawProjectDir}" is not an absolute path — readConfig() silently fell back to the default`,
        affected: [configPath],
        remediation: {
          kind: 'manual',
          suggestion: 'Set `defaultProjectDir` to an absolute path (or a `~/`-prefixed path)',
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    if (ctx.config.defaultProjectDir !== expanded) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `readConfig() returned defaultProjectDir="${ctx.config.defaultProjectDir}" but config.md declares "${rawProjectDir}" — a silent fallback occurred`,
        affected: [configPath],
        remediation: {
          kind: 'manual',
          suggestion: 'Fix the raw value in config.md so it parses correctly',
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    const nestedMismatch = detectNestedParseMismatch(fmBlock, ctx.config);
    if (nestedMismatch) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `config.md has ${nestedMismatch.field} in raw frontmatter but readConfig() did not load it (parser silently dropped the nested section)`,
        affected: [configPath],
        remediation: {
          kind: 'manual',
          suggestion: `Check indentation under the parent key for ${nestedMismatch.parent}:`,
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    return pass(this);
  },
};

interface NestedMismatch {
  field: string;
  parent: string;
}

function detectNestedParseMismatch(
  fmBlock: string,
  config: {
    integrations: { claudePluginDir: string | null; codexPluginDir: string | null; codexMarketplacePath: string | null };
    backup: { repo: string | null; categories: string; lastBackup: string | null; lastRestore: string | null } | null;
  },
): NestedMismatch | null {
  const integrationChecks: Array<[string, string | null]> = [
    ['integrations.claudePluginDir', config.integrations.claudePluginDir],
    ['integrations.codexPluginDir', config.integrations.codexPluginDir],
    ['integrations.codexMarketplacePath', config.integrations.codexMarketplacePath],
  ];
  for (const [dotted, parsedValue] of integrationChecks) {
    const raw = readNestedField(fmBlock, dotted);
    if (raw !== null && raw !== 'null' && raw !== '' && parsedValue === null) {
      return { field: dotted, parent: 'integrations' };
    }
  }

  const backupFields: Array<[string, string | null]> = [
    ['backup.repo', config.backup?.repo ?? null],
    ['backup.lastBackup', config.backup?.lastBackup ?? null],
    ['backup.lastRestore', config.backup?.lastRestore ?? null],
  ];
  for (const [dotted, parsedValue] of backupFields) {
    const raw = readNestedField(fmBlock, dotted);
    if (raw !== null && raw !== 'null' && raw !== '' && parsedValue === null) {
      return { field: dotted, parent: 'backup' };
    }
  }

  const rawCategories = readNestedField(fmBlock, 'backup.categories');
  if (rawCategories !== null && rawCategories !== '' && config.backup?.categories) {
    const rawNormalized = rawCategories.split(',').map((s) => s.trim()).filter(Boolean).join(',');
    const parsedNormalized = config.backup.categories.split(',').map((s) => s.trim()).filter(Boolean).join(',');
    if (rawNormalized && rawNormalized !== parsedNormalized) {
      return { field: 'backup.categories', parent: 'backup' };
    }
  }

  return null;
}

function readNestedField(fmBlock: string, dotted: string): string | null {
  const [parent, key] = dotted.split('.', 2);
  if (!parent || !key) return null;
  const lines = fmBlock.split('\n');
  const parentPrefix = `${parent}:`;
  let inParent = false;
  for (const line of lines) {
    if (!inParent) {
      if (line.startsWith(parentPrefix)) {
        inParent = true;
      }
      continue;
    }
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (trimmed === '') continue;
    if (indent === 0) {
      // Next top-level key — parent block ended
      return null;
    }
    const stripped = trimmed.startsWith('- ') ? trimmed.slice(2).trimStart() : trimmed;
    const colonIdx = stripped.indexOf(':');
    if (colonIdx < 0) continue;
    const lineKey = stripped.slice(0, colonIdx).trim();
    if (lineKey !== key) continue;
    const raw = stripped.slice(colonIdx + 1).trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  return null;
}

const nodeVersion: Check = {
  id: 'env.node-version',
  category: CATEGORY,
  title: 'Node.js version meets minimum',
  async run() {
    const current = process.versions.node;
    const min = await readEngineMin();
    if (!min) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'could not read engines.node from package.json',
        autoFixable: false,
      } satisfies CheckResult;
    }
    if (!versionGte(current, min)) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `Node ${current} is below required >=${min}`,
        remediation: {
          kind: 'manual',
          suggestion: `Upgrade Node to >=${min}`,
          command: null,
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this, `Node ${current} >= ${min}`);
  },
};

const cliVersion: Check = {
  id: 'env.cli-version',
  category: CATEGORY,
  title: 'CLI version matches latest on npm',
  async run() {
    const local = await readLocalVersion();
    if (!local) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'could not read local package.json version',
        autoFixable: false,
      } satisfies CheckResult;
    }
    const latest = await fetchLatestNpmVersion('syntaur', 2000);
    if (!latest) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'could not reach npm registry (offline or timed out)',
        autoFixable: false,
      } satisfies CheckResult;
    }
    if (local === latest) {
      return pass(this, `syntaur ${local} is latest`);
    }
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'warn',
      detail: `installed syntaur ${local}, latest on npm is ${latest}`,
      remediation: {
        kind: 'manual',
        suggestion: 'Run `npm install -g syntaur@latest` to upgrade',
        command: 'npm install -g syntaur@latest',
      },
      autoFixable: false,
    } satisfies CheckResult;
  },
};

export const envChecks: Check[] = [
  syntaurRootExists,
  configValid,
  nodeVersion,
  cliVersion,
];

function pass(check: { id: string; category: string; title: string }, detail?: string): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'pass',
    detail,
    autoFixable: false,
  };
}

function err(
  check: { id: string; category: string; title: string },
  detail: string,
  affected?: string[],
): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'error',
    detail,
    affected,
    autoFixable: false,
  };
}

async function readEngineMin(): Promise<string | null> {
  const raw = await readLocalPkg();
  if (!raw) return null;
  const engine = raw.engines?.node;
  if (typeof engine !== 'string') return null;
  const match = engine.match(/(\d+(?:\.\d+){0,2})/);
  return match ? match[1] : null;
}

async function readLocalVersion(): Promise<string | null> {
  const raw = await readLocalPkg();
  return typeof raw?.version === 'string' ? raw.version : null;
}

interface LocalPkg {
  version?: unknown;
  engines?: { node?: string };
}

async function readLocalPkg(): Promise<LocalPkg | null> {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = dirname(here);
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, 'package.json');
      try {
        const text = await readFile(candidate, 'utf-8');
        return JSON.parse(text) as LocalPkg;
      } catch {
        dir = dirname(dir);
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchLatestNpmVersion(pkg: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function readTopLevelField(fmBlock: string, key: string): string | null {
  const match = fmBlock.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!match) return null;
  const raw = match[1].trim();
  if (raw === '') return null;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function versionGte(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}
