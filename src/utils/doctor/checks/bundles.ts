import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileExists } from '../../fs.js';
import { todosDir as getTodosDir, projectTodosDir } from '../../paths.js';
import { readBundles } from '../../../todos/bundle-parser.js';
import { readChecklist } from '../../../todos/parser.js';
import type { TodoBundle, TodoItem } from '../../../todos/types.js';
import type { CheckContext, Check, CheckResult } from '../types.js';

const CATEGORY = 'bundles';

interface ScopeView {
  scopeLabel: string;
  todosPath: string;
  checklistKey: string;
}

async function listScopes(ctx: CheckContext): Promise<ScopeView[]> {
  // Workspace + global scopes share the global todosDir; we enumerate each
  // existing top-level workspace checklist plus `_global`.
  const out: ScopeView[] = [];
  const td = getTodosDir();
  if (await fileExists(td)) {
    const entries = await readdir(td).catch(() => [] as string[]);
    for (const f of entries) {
      if (typeof f !== 'string') continue;
      if (!f.endsWith('.md') || f.endsWith('-log.md')) continue;
      const workspace = f.replace(/\.md$/, '');
      out.push({
        scopeLabel: workspace === '_global' ? '_global' : `workspace:${workspace}`,
        todosPath: td,
        checklistKey: workspace,
      });
    }
    if (!out.find((s) => s.checklistKey === '_global')) {
      out.push({ scopeLabel: '_global', todosPath: td, checklistKey: '_global' });
    }
  }
  // Project scopes: every project under ~/.syntaur/projects with a project.md.
  if (await fileExists(ctx.config.defaultProjectDir)) {
    const projectEntries = await readdir(ctx.config.defaultProjectDir, { withFileTypes: true }).catch(() => []);
    for (const e of projectEntries) {
      if (!e.isDirectory()) continue;
      const slug = e.name;
      if (typeof slug !== 'string' || slug.startsWith('.')) continue;
      const projectMd = resolve(ctx.config.defaultProjectDir, slug, 'project.md');
      if (!(await fileExists(projectMd))) continue;
      out.push({
        scopeLabel: `project:${slug}`,
        todosPath: projectTodosDir(ctx.config.defaultProjectDir, slug),
        checklistKey: slug,
      });
    }
  }
  return out;
}

function pass(check: { id: string; category: string; title: string }, detail?: string): CheckResult {
  return { id: check.id, category: check.category, title: check.title, status: 'pass', detail, autoFixable: false };
}

function fail(check: { id: string; category: string; title: string }, detail: string, affected: string[]): CheckResult {
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

function warn(check: { id: string; category: string; title: string }, detail: string, affected: string[], remediation?: { suggestion: string; command?: string | null }): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'warn',
    detail,
    affected,
    remediation: remediation
      ? { kind: 'manual', suggestion: remediation.suggestion, command: remediation.command ?? null }
      : undefined,
    autoFixable: false,
  };
}

interface BundleAndScope {
  bundle: TodoBundle;
  scope: ScopeView;
  members: TodoItem[];
}

async function gatherBundlesByScope(scopes: ScopeView[]): Promise<{ allBundles: BundleAndScope[]; scopedTodos: Map<string, TodoItem[]> }> {
  const all: BundleAndScope[] = [];
  const scopedTodos = new Map<string, TodoItem[]>(); // key: scope label
  for (const sc of scopes) {
    const bundles = await readBundles(sc.todosPath);
    const checklist = await readChecklist(sc.todosPath, sc.checklistKey);
    scopedTodos.set(sc.scopeLabel, checklist.items);
    for (const b of bundles) {
      if (b.scope === 'project' && sc.scopeLabel !== `project:${b.scopeId}`) continue;
      if (b.scope === 'workspace' && sc.scopeLabel !== `workspace:${b.scopeId}`) continue;
      if (b.scope === 'global' && sc.scopeLabel !== '_global') continue;
      all.push({ bundle: b, scope: sc, members: checklist.items.filter((i) => b.todoIds.includes(i.id)) });
    }
  }
  return { allBundles: all, scopedTodos };
}

const orphanBundleId: Check = {
  id: 'bundles.orphan-bundleid',
  category: CATEGORY,
  title: 'Every todo with a bundleId points at an existing bundle in the same scope',
  async run(ctx) {
    const scopes = await listScopes(ctx);
    const { allBundles, scopedTodos } = await gatherBundlesByScope(scopes);
    const results: CheckResult[] = [];
    for (const sc of scopes) {
      const items = scopedTodos.get(sc.scopeLabel) ?? [];
      for (const item of items) {
        if (item.bundleId === null) continue;
        const matching = allBundles.find(
          (bs) => bs.bundle.id === item.bundleId && bs.scope.scopeLabel === sc.scopeLabel,
        );
        if (!matching) {
          results.push(fail(this, `Todo [t:${item.id}] in ${sc.scopeLabel} has bundleId b:${item.bundleId} but no such bundle exists in this scope.`, [sc.todosPath]));
        }
      }
    }
    return results.length === 0 ? pass(this) : results;
  },
};

const missingMembers: Check = {
  id: 'bundles.missing-members',
  category: CATEGORY,
  title: 'Every bundle member exists in the bundle\'s scope checklist',
  async run(ctx) {
    const scopes = await listScopes(ctx);
    const { allBundles } = await gatherBundlesByScope(scopes);
    const results: CheckResult[] = [];
    for (const bs of allBundles) {
      const items = new Set(bs.members.map((m) => m.id));
      for (const memberId of bs.bundle.todoIds) {
        if (!items.has(memberId)) {
          results.push(fail(this, `Bundle b:${bs.bundle.id} (${bs.scope.scopeLabel}) references missing member t:${memberId}.`, [bs.scope.todosPath]));
        }
      }
    }
    return results.length === 0 ? pass(this) : results;
  },
};

const scopeMismatch: Check = {
  id: 'bundles.scope-mismatch',
  category: CATEGORY,
  title: 'Every bundle member\'s bundleId matches the bundle id',
  async run(ctx) {
    const scopes = await listScopes(ctx);
    const { allBundles } = await gatherBundlesByScope(scopes);
    const results: CheckResult[] = [];
    for (const bs of allBundles) {
      for (const member of bs.members) {
        if (member.bundleId !== bs.bundle.id) {
          results.push(fail(this, `Bundle b:${bs.bundle.id} (${bs.scope.scopeLabel}) lists t:${member.id} but the todo's bundleId is "${member.bundleId ?? 'null'}".`, [bs.scope.todosPath]));
        }
      }
    }
    return results.length === 0 ? pass(this) : results;
  },
};

const minMembers: Check = {
  id: 'bundles.min-members',
  category: CATEGORY,
  title: 'Every bundle has at least 2 members',
  async run(ctx) {
    const scopes = await listScopes(ctx);
    const { allBundles } = await gatherBundlesByScope(scopes);
    const results: CheckResult[] = [];
    for (const bs of allBundles) {
      if (bs.bundle.todoIds.length < 2) {
        results.push(fail(this, `Bundle b:${bs.bundle.id} (${bs.scope.scopeLabel}) has only ${bs.bundle.todoIds.length} member(s). Bundles require at least 2; run \`syntaur todo bundle dissolve b:${bs.bundle.id}\`.`, [bs.scope.todosPath]));
      }
    }
    return results.length === 0 ? pass(this) : results;
  },
};

const stalePlanDir: Check = {
  id: 'bundles.stale-plan-dir',
  category: CATEGORY,
  title: 'Every bundle\'s persisted planDir still exists on disk',
  async run(ctx) {
    const scopes = await listScopes(ctx);
    const { allBundles } = await gatherBundlesByScope(scopes);
    const results: CheckResult[] = [];
    for (const bs of allBundles) {
      if (bs.bundle.planDir === null) continue;
      if (!(await fileExists(bs.bundle.planDir))) {
        results.push(
          warn(
            this,
            `Bundle b:${bs.bundle.id} (${bs.scope.scopeLabel}) has planDir ${bs.bundle.planDir} but it no longer exists on disk.`,
            [bs.bundle.planDir],
            { suggestion: `Rerun \`syntaur todo bundle plan b:${bs.bundle.id}\` to re-create the plan dir, or clear the planDir field.` },
          ),
        );
      }
    }
    return results.length === 0 ? pass(this) : results;
  },
};

const staleWorktree: Check = {
  id: 'bundles.stale-worktree',
  category: CATEGORY,
  title: 'Every bundle\'s persisted worktree still exists in the repo',
  async run(ctx) {
    const scopes = await listScopes(ctx);
    const { allBundles } = await gatherBundlesByScope(scopes);
    const results: CheckResult[] = [];
    for (const bs of allBundles) {
      if (bs.bundle.worktreePath === null || bs.bundle.repository === null) continue;
      const onDisk = await fileExists(bs.bundle.worktreePath);
      let gitKnowsIt = false;
      const gitOut = spawnSync('git', ['-C', bs.bundle.repository, 'worktree', 'list', '--porcelain'], { encoding: 'utf-8' });
      if (gitOut.status === 0) {
        gitKnowsIt = gitOut.stdout.split('\n').some((l) => l.trim() === `worktree ${bs.bundle.worktreePath}`);
      }
      if (!onDisk || !gitKnowsIt) {
        results.push(
          warn(
            this,
            `Bundle b:${bs.bundle.id} (${bs.scope.scopeLabel}) references worktree ${bs.bundle.worktreePath} in repo ${bs.bundle.repository} but ${!onDisk ? 'the directory is missing' : 'git no longer tracks it'}.`,
            [bs.bundle.worktreePath, bs.bundle.repository],
            { suggestion: `Rerun \`syntaur todo bundle worktree b:${bs.bundle.id} --branch <name>\` to re-create it, or dissolve the bundle if abandoned.` },
          ),
        );
      }
    }
    return results.length === 0 ? pass(this) : results;
  },
};

export const bundleChecks: Check[] = [
  orphanBundleId,
  missingMembers,
  scopeMismatch,
  minMembers,
  stalePlanDir,
  staleWorktree,
];
