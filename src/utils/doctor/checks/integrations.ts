import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
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

export const integrationChecks: Check[] = [claudePluginLinked, codexPluginLinked, backupConfigured];

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
