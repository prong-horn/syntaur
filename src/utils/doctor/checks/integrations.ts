import { resolve, dirname, basename } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileExists } from '../../fs.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'integrations';

const claudePluginLinked: Check = {
  id: 'integrations.claude-plugin-linked',
  category: CATEGORY,
  title: 'Configured Claude plugin directory exists',
  async run(ctx) {
    const dir = ctx.config.integrations.claudePluginDir;
    if (!dir) return skipped(this, 'claudePluginDir not configured');
    if (!(await fileExists(dir))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `claudePluginDir points to ${dir} but that directory does not exist`,
        affected: [dir],
        remediation: {
          kind: 'manual',
          suggestion: 'Reinstall the Claude plugin or update the path in ~/.syntaur/config.md',
          command: 'syntaur install-plugin',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this);
  },
};

const codexPluginLinked: Check = {
  id: 'integrations.codex-plugin-linked',
  category: CATEGORY,
  title: 'Configured Codex plugin directory exists',
  async run(ctx) {
    const dir = ctx.config.integrations.codexPluginDir;
    if (!dir) return skipped(this, 'codexPluginDir not configured');
    if (!(await fileExists(dir))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `codexPluginDir points to ${dir} but that directory does not exist`,
        affected: [dir],
        remediation: {
          kind: 'manual',
          suggestion: 'Reinstall the Codex plugin or update the path in ~/.syntaur/config.md',
          command: 'syntaur install-codex-plugin',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    return pass(this);
  },
};

const backupConfigured: Check = {
  id: 'integrations.backup-configured',
  category: CATEGORY,
  title: 'GitHub backup is configured (if user has projects)',
  async run(ctx) {
    if (ctx.config.backup?.repo) return pass(this);
    const projectsDir = ctx.config.defaultProjectDir;
    if (!(await fileExists(projectsDir))) return skipped(this, 'no projects dir');
    const entries = await readdir(projectsDir, { withFileTypes: true });
    const hasProjects = entries.some((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'));
    if (!hasProjects) return skipped(this, 'no projects yet');
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'warn',
      detail: 'you have projects but no GitHub backup repo configured',
      remediation: {
        kind: 'manual',
        suggestion: 'Run `syntaur backup config --repo <url>` to configure',
        command: null,
      },
      autoFixable: false,
    } satisfies CheckResult;
  },
};

// Reads ~/.claude/plugins/known_marketplaces.json safely.
async function readKnownMarketplaces(): Promise<Record<string, { installLocation?: string }>> {
  const path = resolve(homedir(), '.claude', 'plugins', 'known_marketplaces.json');
  if (!(await fileExists(path))) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as Record<string, { installLocation?: string }>;
  } catch {
    return {};
  }
}

const claudeMarketplaceRegistered: Check = {
  id: 'integrations.claude-marketplace-registered',
  category: CATEGORY,
  title: 'Claude marketplace containing syntaur is registered in known_marketplaces.json',
  async run(ctx) {
    const dir = ctx.config.integrations.claudePluginDir;
    if (!dir) return skipped(this, 'claudePluginDir not configured');
    if (!(await fileExists(dir))) {
      return skipped(this, 'claudePluginDir does not exist (run install-plugin)');
    }

    // The plugin lives at <marketplace>/plugins/<name>; walk up two levels.
    const pluginsParent = dirname(dir);
    if (basename(pluginsParent) !== 'plugins') {
      return skipped(this, 'plugin not inside a marketplace layout');
    }
    const marketplaceRoot = dirname(pluginsParent);
    const marketplaceManifest = resolve(marketplaceRoot, '.claude-plugin', 'marketplace.json');
    if (!(await fileExists(marketplaceManifest))) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `${marketplaceManifest} does not exist — Claude won't see this plugin.`,
        affected: [marketplaceManifest],
        remediation: {
          kind: 'manual',
          suggestion: 'Re-run install-plugin to repair the marketplace files.',
          command: 'syntaur install-plugin',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }

    let parsed: { name?: string; plugins?: Array<{ name?: string }> } = {};
    try {
      parsed = JSON.parse(await readFile(marketplaceManifest, 'utf-8'));
    } catch {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `${marketplaceManifest} is not valid JSON.`,
        affected: [marketplaceManifest],
        autoFixable: false,
      } satisfies CheckResult;
    }
    const marketplaceName = parsed.name ?? basename(marketplaceRoot);
    const hasSyntaurEntry = (parsed.plugins ?? []).some((p) => p?.name === 'syntaur');

    const known = await readKnownMarketplaces();
    const registered =
      known[marketplaceName]?.installLocation === marketplaceRoot ||
      Object.values(known).some((v) => v.installLocation === marketplaceRoot);

    const issues: string[] = [];
    if (!hasSyntaurEntry) {
      issues.push(`marketplace.json at ${marketplaceManifest} does not list a "syntaur" plugin`);
    }
    if (!registered) {
      issues.push(
        `known_marketplaces.json does not register ${marketplaceName} → ${marketplaceRoot} (Claude will not show this plugin)`,
      );
    }

    if (issues.length === 0) return pass(this);
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'error',
      detail: issues.join('; '),
      affected: [marketplaceManifest, resolve(homedir(), '.claude', 'plugins', 'known_marketplaces.json')],
      remediation: {
        kind: 'manual',
        suggestion: 'Re-run install-plugin to ensure both files are in sync.',
        command: 'syntaur install-plugin',
      },
      autoFixable: false,
    } satisfies CheckResult;
  },
};

export const integrationChecks: Check[] = [
  claudePluginLinked,
  claudeMarketplaceRegistered,
  codexPluginLinked,
  backupConfigured,
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

function skipped(check: { id: string; category: string; title: string }, reason: string): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'skipped',
    detail: reason,
    autoFixable: false,
  };
}
