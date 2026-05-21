import { Command } from 'commander';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  bundlePlanDir,
  bundlesDir,
  bundlesPath,
  projectTodosDir,
  todosDir as getTodosDir,
} from '../utils/paths.js';
import {
  readBundles,
  writeBundles,
  generateUniqueBundleId,
} from '../todos/bundle-parser.js';
import {
  readChecklist,
  writeChecklist,
  appendLogEntry,
  checklistPath,
} from '../todos/parser.js';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { createWorktreeForBundle } from '../utils/git-worktree.js';
import type {
  TodoItem,
  TodoBundle,
  BundleScope,
  BundleStatusSummary,
  LogEntry,
} from '../todos/types.js';

const WORKSPACE_REGEX = /^[a-z0-9_][a-z0-9-]*$/;
const BUNDLE_ID_RE = /^[a-f0-9]{4}$/;

interface ScopeOptions {
  project?: string;
  workspace?: string;
  global?: boolean;
}

interface ResolvedBundleScope {
  scope: BundleScope;
  scopeId: string;
  todosPath: string;
  /** Workspace key used by readChecklist/writeChecklist for the member todos in this scope. */
  checklistKey: string;
  label: string;
}

async function resolveBundleScope(options: ScopeOptions): Promise<ResolvedBundleScope> {
  const flagCount = [Boolean(options.project), Boolean(options.workspace), Boolean(options.global)].filter(Boolean).length;
  if (flagCount > 1) {
    throw new Error('Use at most one of --project, --workspace, --global.');
  }
  if (options.project) {
    if (!isValidSlug(options.project)) {
      throw new Error(`Invalid project slug: "${options.project}".`);
    }
    const config = await readConfig();
    const projectMd = resolve(config.defaultProjectDir, options.project, 'project.md');
    if (!(await fileExists(projectMd))) {
      throw new Error(`Project "${options.project}" not found.`);
    }
    const todosPath = projectTodosDir(config.defaultProjectDir, options.project);
    return {
      scope: 'project',
      scopeId: options.project,
      todosPath,
      checklistKey: options.project,
      label: `project:${options.project}`,
    };
  }
  if (options.workspace) {
    if (!WORKSPACE_REGEX.test(options.workspace)) {
      throw new Error(`Invalid workspace name: "${options.workspace}". Use lowercase letters, numbers, hyphens, and underscores.`);
    }
    return {
      scope: 'workspace',
      scopeId: options.workspace,
      todosPath: getTodosDir(),
      checklistKey: options.workspace,
      label: `workspace:${options.workspace}`,
    };
  }
  return {
    scope: 'global',
    scopeId: '_global',
    todosPath: getTodosDir(),
    checklistKey: '_global',
    label: '_global',
  };
}

function nowISO(): string {
  return new Date().toISOString();
}

function touchTodo(item: TodoItem): void {
  if (item.createdAt === null) item.createdAt = nowISO();
  item.updatedAt = nowISO();
}

function stripBundlePrefix(s: string): string {
  return s.startsWith('b:') ? s.slice(2) : s;
}

function deriveStatus(bundle: TodoBundle, items: TodoItem[]): BundleStatusSummary {
  const members = bundle.todoIds
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is TodoItem => i !== undefined);
  const counts = { open: 0, in_progress: 0, blocked: 0, completed: 0, total: members.length };
  for (const m of members) counts[m.status]++;
  let status: BundleStatusSummary['status'];
  if (counts.total === 0) status = 'open';
  else if (counts.completed === counts.total) status = 'completed';
  else if (counts.completed > 0 && counts.completed < counts.total) status = 'mixed';
  else if (counts.in_progress > 0) status = 'in_progress';
  else if (counts.blocked > 0) status = 'blocked';
  else status = 'open';
  return { status, counts };
}

const STATUS_ICONS: Record<BundleStatusSummary['status'], string> = {
  open: '[ ]',
  in_progress: '[>]',
  blocked: '[!]',
  completed: '[x]',
  mixed: '[~]',
};

function pickNextPlanFile(planDir: string, existingFiles: string[]): { target: string; version: number } {
  const versions = new Set<number>();
  for (const f of existingFiles) {
    if (f === 'plan.md') versions.add(1);
    const m = f.match(/^plan-v(\d+)\.md$/);
    if (m) versions.add(parseInt(m[1], 10));
  }
  if (versions.size === 0) return { target: resolve(planDir, 'plan.md'), version: 1 };
  let n = 2;
  while (versions.has(n)) n++;
  return { target: resolve(planDir, `plan-v${n}.md`), version: n };
}

function dedupePreserveOrder(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

async function loadBundleOrThrow(
  todosPath: string,
  bundleId: string,
): Promise<{ bundle: TodoBundle; bundles: TodoBundle[] }> {
  const bundles = await readBundles(todosPath);
  const bundle = bundles.find((b) => b.id === bundleId);
  if (!bundle) throw new Error(`Bundle b:${bundleId} not found.`);
  return { bundle, bundles };
}

function bundleInScope(b: TodoBundle, sc: ResolvedBundleScope): boolean {
  return b.scope === sc.scope && b.scopeId === sc.scopeId;
}

export const bundleCommand = new Command('bundle').description('Manage todo bundles');

// --- `bundle new` ---
bundleCommand
  .command('new')
  .description('Create a new bundle from 2+ existing todos in a single scope')
  .argument('<ids...>', 'Todo short IDs to bundle (>= 2)')
  .option('--slug <slug>', 'Optional human slug (lowercase-alphanum-hyphen)')
  .option('--branch <name>', 'Preset bundle.branch (does not create a worktree; use `bundle worktree` for that)')
  .option('--plan', 'After creating the bundle, immediately create plan.md and print its path')
  .option('--workspace <slug>', 'Workspace scope')
  .option('--project <slug>', 'Project scope')
  .option('--global', 'Global scope (default)')
  .action(async (ids: string[], options) => {
    try {
      const uniqueIds = dedupePreserveOrder(ids);
      if (uniqueIds.length !== ids.length) {
        throw new Error('Duplicate todo ids in input.');
      }
      if (uniqueIds.length < 2) {
        throw new Error('Bundles require at least 2 todos. For a single todo, use `syntaur todo plan` directly.');
      }
      if (options.slug && !isValidSlug(options.slug)) {
        throw new Error(`Invalid bundle slug "${options.slug}". Use lowercase-alphanum-hyphen (workspace names may use underscores; bundle slugs may not).`);
      }
      const sc = await resolveBundleScope(options);
      const checklist = await readChecklist(sc.todosPath, sc.checklistKey);
      const items: TodoItem[] = [];
      for (const id of uniqueIds) {
        const item = checklist.items.find((i) => i.id === id);
        if (!item) throw new Error(`Todo [t:${id}] not found in scope ${sc.label}.`);
        if (item.status === 'completed') {
          throw new Error(`Todo [t:${id}] is already completed; cannot bundle.`);
        }
        if (item.bundleId !== null) {
          throw new Error(`Todo [t:${id}] is already part of bundle b:${item.bundleId}.`);
        }
        items.push(item);
      }
      const bundles = await readBundles(sc.todosPath);
      if (options.slug) {
        const dupSlug = bundles.find((b) => bundleInScope(b, sc) && b.slug === options.slug);
        if (dupSlug) {
          throw new Error(`A bundle with slug "${options.slug}" already exists in scope ${sc.label} (b:${dupSlug.id}).`);
        }
      }
      const existingIds = new Set(bundles.map((b) => b.id));
      const id = generateUniqueBundleId(existingIds);
      const now = nowISO();
      const bundle: TodoBundle = {
        id,
        slug: options.slug ?? null,
        scope: sc.scope,
        scopeId: sc.scopeId,
        todoIds: uniqueIds,
        planDir: null,
        branch: options.branch ?? null,
        worktreePath: null,
        repository: null,
        createdAt: now,
        updatedAt: now,
      };
      bundles.push(bundle);
      await writeBundles(sc.todosPath, bundles);
      for (const item of items) {
        item.bundleId = id;
        if (options.branch) item.branch = options.branch;
        touchTodo(item);
      }
      await writeChecklist(sc.todosPath, checklist);
      console.log(`Created bundle b:${id} (slug: ${bundle.slug ?? '-'}) with ${uniqueIds.length} members in scope ${sc.label}`);
      if (options.plan) {
        const planDir = bundlePlanDir(sc.todosPath, sc.scopeId, id);
        await ensureDir(planDir);
        const target = resolve(planDir, 'plan.md');
        const memberLines = items.map((it) => `- ${it.description} [t:${it.id}]`).join('\n');
        const stub = [
          '---',
          `bundle: b:${id}`,
          `todos: [${uniqueIds.map((tid) => `"t:${tid}"`).join(', ')}]`,
          `scope: ${bundle.scope}:${bundle.scopeId}`,
          'status: draft',
          `created: "${now}"`,
          `updated: "${now}"`,
          '---',
          '',
          `# Plan for bundle b:${id}`,
          '',
          bundle.slug ?? '',
          '',
          '## Members',
          '',
          memberLines,
          '',
        ].join('\n');
        await writeFileForce(target, stub);
        bundle.planDir = planDir;
        bundle.updatedAt = nowISO();
        for (const item of items) {
          item.planDir = planDir;
          touchTodo(item);
        }
        // Re-read bundles to avoid a stale write — but we already hold the in-memory copy that was just persisted, so re-persist the mutated bundle.
        await writeBundles(sc.todosPath, bundles);
        await writeChecklist(sc.todosPath, checklist);
        console.log(target);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// --- `bundle list` ---
bundleCommand
  .command('list')
  .description('List bundles in a scope with derived status')
  .option('--with-members', 'Expand each bundle to show its members')
  .option('--workspace <slug>', 'Workspace scope')
  .option('--project <slug>', 'Project scope')
  .option('--global', 'Global scope (default)')
  .action(async (options) => {
    try {
      const sc = await resolveBundleScope(options);
      const allBundles = await readBundles(sc.todosPath);
      const bundles = allBundles.filter((b) => bundleInScope(b, sc));
      if (bundles.length === 0) {
        console.log('No bundles found.');
        return;
      }
      const checklist = await readChecklist(sc.todosPath, sc.checklistKey);
      for (const b of bundles) {
        const summary = deriveStatus(b, checklist.items);
        const icon = STATUS_ICONS[summary.status];
        const slug = b.slug ? ` ${b.slug}` : '';
        const branch = b.branch ?? '-';
        console.log(`${icon} b:${b.id}${slug} ${summary.counts.completed}/${summary.counts.total} done  scope=${b.scope}:${b.scopeId} branch=${branch} [${b.todoIds.map((id) => `t:${id}`).join(',')}]`);
        if (options.withMembers) {
          for (const memberId of b.todoIds) {
            const item = checklist.items.find((i) => i.id === memberId);
            if (!item) {
              console.log(`    [?] (missing) [t:${memberId}]`);
              continue;
            }
            const memberIcon = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : item.status === 'blocked' ? '[!]' : '[ ]';
            console.log(`    ${memberIcon} ${item.description} [t:${item.id}]`);
          }
        }
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// --- `bundle show` ---
bundleCommand
  .command('show')
  .description('Show metadata + members for a single bundle')
  .argument('<bundle-id>', 'Bundle id (with or without `b:` prefix)')
  .option('--workspace <slug>', 'Workspace scope')
  .option('--project <slug>', 'Project scope')
  .option('--global', 'Global scope (default)')
  .action(async (rawId: string, options) => {
    try {
      const id = stripBundlePrefix(rawId);
      if (!BUNDLE_ID_RE.test(id)) throw new Error(`Invalid bundle id "${rawId}". Expected 4-hex.`);
      const sc = await resolveBundleScope(options);
      const { bundle } = await loadBundleOrThrow(sc.todosPath, id);
      if (!bundleInScope(bundle, sc)) {
        throw new Error(`Bundle b:${id} is in scope ${bundle.scope}:${bundle.scopeId}, not ${sc.label}.`);
      }
      const checklist = await readChecklist(sc.todosPath, sc.checklistKey);
      const summary = deriveStatus(bundle, checklist.items);
      console.log(`Bundle b:${bundle.id}`);
      console.log(`  Slug: ${bundle.slug ?? '-'}`);
      console.log(`  Scope: ${bundle.scope}:${bundle.scopeId}`);
      console.log(`  Status: ${summary.status} (${summary.counts.completed}/${summary.counts.total} done)`);
      console.log(`  Plan: ${bundle.planDir ?? '-'}`);
      console.log(`  Branch: ${bundle.branch ?? '-'}`);
      console.log(`  Worktree: ${bundle.worktreePath ?? '-'}`);
      console.log(`  Repository: ${bundle.repository ?? '-'}`);
      console.log(`  Created: ${bundle.createdAt}`);
      console.log(`  Updated: ${bundle.updatedAt}`);
      console.log(`  Members (${bundle.todoIds.length}):`);
      for (const memberId of bundle.todoIds) {
        const item = checklist.items.find((i) => i.id === memberId);
        if (!item) {
          console.log(`    [?] (missing) [t:${memberId}]`);
          continue;
        }
        const icon = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : item.status === 'blocked' ? '[!]' : '[ ]';
        console.log(`    ${icon} ${item.description} [t:${item.id}]`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// --- `bundle plan` ---
bundleCommand
  .command('plan')
  .description('Create or open the bundle\'s shared plan file (plan.md / plan-v<N>.md)')
  .argument('<bundle-id>', 'Bundle id (with or without `b:` prefix)')
  .option('--workspace <slug>', 'Workspace scope')
  .option('--project <slug>', 'Project scope')
  .option('--global', 'Global scope (default)')
  .action(async (rawId: string, options) => {
    try {
      const id = stripBundlePrefix(rawId);
      if (!BUNDLE_ID_RE.test(id)) throw new Error(`Invalid bundle id "${rawId}".`);
      const sc = await resolveBundleScope(options);
      const { bundle, bundles } = await loadBundleOrThrow(sc.todosPath, id);
      if (!bundleInScope(bundle, sc)) {
        throw new Error(`Bundle b:${id} is in scope ${bundle.scope}:${bundle.scopeId}, not ${sc.label}.`);
      }
      const planDir = bundlePlanDir(sc.todosPath, sc.scopeId, id);
      await ensureDir(planDir);
      const existing = (await readdir(planDir).catch(() => [])).filter((f) => /^plan(?:-v\d+)?\.md$/.test(f));
      const { target } = pickNextPlanFile(planDir, existing);
      const checklist = await readChecklist(sc.todosPath, sc.checklistKey);
      if (!(await fileExists(target))) {
        const memberLines = bundle.todoIds.map((memberId) => {
          const item = checklist.items.find((i) => i.id === memberId);
          return `- ${item?.description ?? '(missing)'} [t:${memberId}]`;
        }).join('\n');
        const stub = [
          '---',
          `bundle: b:${id}`,
          `todos: [${bundle.todoIds.map((tid) => `"t:${tid}"`).join(', ')}]`,
          `scope: ${bundle.scope}:${bundle.scopeId}`,
          'status: draft',
          `created: "${nowISO()}"`,
          `updated: "${nowISO()}"`,
          '---',
          '',
          `# Plan for bundle b:${id}`,
          '',
          bundle.slug ?? '',
          '',
          '## Members',
          '',
          memberLines,
          '',
        ].join('\n');
        await writeFileForce(target, stub);
      }
      // Update bundle + member planDir.
      bundle.planDir = planDir;
      bundle.updatedAt = nowISO();
      await writeBundles(sc.todosPath, bundles);
      for (const memberId of bundle.todoIds) {
        const item = checklist.items.find((i) => i.id === memberId);
        if (!item) continue;
        item.planDir = planDir;
        touchTodo(item);
      }
      await writeChecklist(sc.todosPath, checklist);
      console.log(target);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// --- `bundle worktree` ---
bundleCommand
  .command('worktree')
  .description('Create a git worktree for the bundle and bind a context.json inside it')
  .argument('<bundle-id>', 'Bundle id (with or without `b:` prefix)')
  .requiredOption('--branch <name>', 'Branch name to create (also used as worktree dir name)')
  .option('--repository <path>', 'Repository root (defaults to current working directory)')
  .option('--parent-branch <name>', 'Parent branch to fork from', 'main')
  .option('--worktree-path <path>', 'Override the computed <repository>/.worktrees/<branch> path')
  .option('--workspace <slug>', 'Workspace scope')
  .option('--project <slug>', 'Project scope')
  .option('--global', 'Global scope (default)')
  .action(async (rawId: string, options) => {
    try {
      const id = stripBundlePrefix(rawId);
      if (!BUNDLE_ID_RE.test(id)) throw new Error(`Invalid bundle id "${rawId}".`);
      const sc = await resolveBundleScope(options);
      const { bundle, bundles } = await loadBundleOrThrow(sc.todosPath, id);
      if (!bundleInScope(bundle, sc)) {
        throw new Error(`Bundle b:${id} is in scope ${bundle.scope}:${bundle.scopeId}, not ${sc.label}.`);
      }
      if (bundle.worktreePath) {
        throw new Error(`Bundle b:${id} already has a worktree at ${bundle.worktreePath}. Use it or run \`bundle dissolve\` first.`);
      }
      const repository = options.repository ?? process.cwd();
      const parentBranch = options.parentBranch ?? 'main';
      const worktreePath = options.worktreePath ?? resolve(repository, '.worktrees', options.branch);
      const checklist = await readChecklist(sc.todosPath, sc.checklistKey);
      // Confirm every member is still present before we touch git.
      for (const memberId of bundle.todoIds) {
        const item = checklist.items.find((i) => i.id === memberId);
        if (!item) {
          throw new Error(`Bundle member t:${memberId} missing from checklist (run \`syntaur doctor\`).`);
        }
      }

      // Snapshot the on-disk state of both persisted files before record()
      // mutates them, so a late failure (context.json write) can restore
      // bundles/index.md and the checklist alongside git rolling back the
      // worktree+branch. Without this snapshot the bundle would point at a
      // worktreePath that no longer exists, jamming reruns.
      const bundlesFilePath = bundlesPath(sc.todosPath);
      const checklistFilePath = checklistPath(sc.todosPath, sc.checklistKey);
      const bundlesSnapshot = (await fileExists(bundlesFilePath))
        ? await readFile(bundlesFilePath, 'utf-8')
        : null;
      const checklistSnapshot = (await fileExists(checklistFilePath))
        ? await readFile(checklistFilePath, 'utf-8')
        : null;

      const record = async (): Promise<void> => {
        bundle.branch = options.branch;
        bundle.worktreePath = worktreePath;
        bundle.repository = repository;
        bundle.updatedAt = nowISO();
        for (const memberId of bundle.todoIds) {
          const item = checklist.items.find((i) => i.id === memberId);
          if (!item) throw new Error(`Bundle member t:${memberId} missing from checklist.`);
          item.branch = options.branch;
          item.worktreePath = worktreePath;
          touchTodo(item);
        }
        try {
          await writeBundles(sc.todosPath, bundles);
          await writeChecklist(sc.todosPath, checklist);
          const ctxDir = resolve(worktreePath, '.syntaur');
          await mkdir(ctxDir, { recursive: true });
          const payload = {
            bundleId: bundle.id,
            bundleSlug: bundle.slug,
            bundleScope: bundle.scope,
            bundleScopeId: bundle.scopeId,
            todoIds: bundle.todoIds,
            planDir: bundle.planDir,
            branch: options.branch,
            worktreePath,
            repository,
            boundAt: nowISO(),
          };
          await writeFile(resolve(ctxDir, 'context.json'), JSON.stringify(payload, null, 2) + '\n');
        } catch (err) {
          // Restore on-disk state from snapshots BEFORE rethrowing so the
          // git rollback in createWorktreeForBundle's catch sees nothing
          // half-persisted. Best-effort: log but do not mask the original
          // failure.
          try {
            if (bundlesSnapshot === null) {
              await rm(bundlesFilePath, { force: true });
            } else {
              await writeFileForce(bundlesFilePath, bundlesSnapshot);
            }
            if (checklistSnapshot === null) {
              await rm(checklistFilePath, { force: true });
            } else {
              await writeFileForce(checklistFilePath, checklistSnapshot);
            }
          } catch {
            // Restore failure is non-fatal here; the outer rollback error
            // message already names the worktree and branch as orphans.
          }
          throw err;
        }
      };

      await createWorktreeForBundle({
        repository,
        branch: options.branch,
        worktreePath,
        parentBranch,
        record,
      });
      console.log(`Created worktree at ${worktreePath}`);
      console.log(`Bound bundle b:${id} with ${bundle.todoIds.length} member todos`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// --- `bundle add` ---
bundleCommand
  .command('add')
  .description('Add one or more existing todos to a bundle (same scope only)')
  .argument('<bundle-id>', 'Bundle id (with or without `b:` prefix)')
  .argument('<todo-ids...>', 'Todo short IDs to add')
  .option('--workspace <slug>', 'Workspace scope')
  .option('--project <slug>', 'Project scope')
  .option('--global', 'Global scope (default)')
  .action(async (rawId: string, todoIds: string[], options) => {
    try {
      const id = stripBundlePrefix(rawId);
      if (!BUNDLE_ID_RE.test(id)) throw new Error(`Invalid bundle id "${rawId}".`);
      const sc = await resolveBundleScope(options);
      const { bundle, bundles } = await loadBundleOrThrow(sc.todosPath, id);
      if (!bundleInScope(bundle, sc)) {
        throw new Error(`Bundle b:${id} is in scope ${bundle.scope}:${bundle.scopeId}, not ${sc.label}.`);
      }
      const checklist = await readChecklist(sc.todosPath, sc.checklistKey);
      const toAdd: TodoItem[] = [];
      for (const tid of todoIds) {
        const item = checklist.items.find((i) => i.id === tid);
        if (!item) throw new Error(`Todo [t:${tid}] not found in scope ${sc.label}.`);
        if (item.status === 'completed') throw new Error(`Todo [t:${tid}] is already completed; cannot bundle.`);
        if (item.bundleId !== null) {
          if (item.bundleId === id) throw new Error(`Todo [t:${tid}] is already in bundle b:${id}.`);
          throw new Error(`Todo [t:${tid}] is already part of bundle b:${item.bundleId}.`);
        }
        toAdd.push(item);
      }
      for (const item of toAdd) {
        bundle.todoIds.push(item.id);
        item.bundleId = id;
        touchTodo(item);
      }
      bundle.updatedAt = nowISO();
      await writeBundles(sc.todosPath, bundles);
      await writeChecklist(sc.todosPath, checklist);
      console.log(`Added ${toAdd.length} todo(s) to bundle b:${id}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// --- `bundle remove` ---
bundleCommand
  .command('remove')
  .description('Remove one or more todos from a bundle (refuses to leave < 2 members)')
  .argument('<bundle-id>', 'Bundle id (with or without `b:` prefix)')
  .argument('<todo-ids...>', 'Todo short IDs to remove')
  .option('--workspace <slug>', 'Workspace scope')
  .option('--project <slug>', 'Project scope')
  .option('--global', 'Global scope (default)')
  .action(async (rawId: string, todoIds: string[], options) => {
    try {
      const id = stripBundlePrefix(rawId);
      if (!BUNDLE_ID_RE.test(id)) throw new Error(`Invalid bundle id "${rawId}".`);
      const sc = await resolveBundleScope(options);
      const { bundle, bundles } = await loadBundleOrThrow(sc.todosPath, id);
      if (!bundleInScope(bundle, sc)) {
        throw new Error(`Bundle b:${id} is in scope ${bundle.scope}:${bundle.scopeId}, not ${sc.label}.`);
      }
      const removalSet = new Set(todoIds);
      for (const tid of todoIds) {
        if (!bundle.todoIds.includes(tid)) {
          throw new Error(`Todo [t:${tid}] is not a member of bundle b:${id}.`);
        }
      }
      const remaining = bundle.todoIds.length - removalSet.size;
      if (remaining < 2) {
        throw new Error(`Cannot leave bundle with fewer than 2 members. Use \`syntaur todo bundle dissolve b:${id}\` to break it up.`);
      }
      const checklist = await readChecklist(sc.todosPath, sc.checklistKey);
      bundle.todoIds = bundle.todoIds.filter((tid) => !removalSet.has(tid));
      for (const tid of removalSet) {
        const item = checklist.items.find((i) => i.id === tid);
        if (item) {
          item.bundleId = null;
          touchTodo(item);
        }
      }
      bundle.updatedAt = nowISO();
      await writeBundles(sc.todosPath, bundles);
      await writeChecklist(sc.todosPath, checklist);
      console.log(`Removed ${removalSet.size} todo(s) from bundle b:${id} (${remaining} remaining)`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// --- `bundle dissolve` ---
bundleCommand
  .command('dissolve')
  .description('Dissolve a bundle: clear each member\'s bundleId; preserve member status / planDir / branch / worktreePath')
  .argument('<bundle-id>', 'Bundle id (with or without `b:` prefix)')
  .option('--workspace <slug>', 'Workspace scope')
  .option('--project <slug>', 'Project scope')
  .option('--global', 'Global scope (default)')
  .action(async (rawId: string, options) => {
    try {
      const id = stripBundlePrefix(rawId);
      if (!BUNDLE_ID_RE.test(id)) throw new Error(`Invalid bundle id "${rawId}".`);
      const sc = await resolveBundleScope(options);
      const { bundle, bundles } = await loadBundleOrThrow(sc.todosPath, id);
      if (!bundleInScope(bundle, sc)) {
        throw new Error(`Bundle b:${id} is in scope ${bundle.scope}:${bundle.scopeId}, not ${sc.label}.`);
      }
      const checklist = await readChecklist(sc.todosPath, sc.checklistKey);
      const memberIds = [...bundle.todoIds];
      for (const memberId of memberIds) {
        const item = checklist.items.find((i) => i.id === memberId);
        if (item) {
          item.bundleId = null;
          touchTodo(item);
        }
      }
      // Remove the bundle.
      const remainingBundles = bundles.filter((b) => b.id !== id);
      await writeBundles(sc.todosPath, remainingBundles);
      await writeChecklist(sc.todosPath, checklist);
      console.log(`Dissolved bundle b:${id}; ${memberIds.length} todos returned to free state.`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// --- `bundle complete` ---
bundleCommand
  .command('complete')
  .description('Bulk-complete every member todo of a bundle')
  .argument('<bundle-id>', 'Bundle id (with or without `b:` prefix)')
  .option('--summary <text>', 'Optional shared completion summary')
  .option('--workspace <slug>', 'Workspace scope')
  .option('--project <slug>', 'Project scope')
  .option('--global', 'Global scope (default)')
  .action(async (rawId: string, options) => {
    try {
      const id = stripBundlePrefix(rawId);
      if (!BUNDLE_ID_RE.test(id)) throw new Error(`Invalid bundle id "${rawId}".`);
      const sc = await resolveBundleScope(options);
      const { bundle, bundles } = await loadBundleOrThrow(sc.todosPath, id);
      if (!bundleInScope(bundle, sc)) {
        throw new Error(`Bundle b:${id} is in scope ${bundle.scope}:${bundle.scopeId}, not ${sc.label}.`);
      }
      const checklist = await readChecklist(sc.todosPath, sc.checklistKey);
      const newlyCompleted: TodoItem[] = [];
      for (const memberId of bundle.todoIds) {
        const item = checklist.items.find((i) => i.id === memberId);
        if (!item) {
          throw new Error(`Bundle member t:${memberId} missing from checklist; refusing partial complete. Run \`syntaur doctor\`.`);
        }
        if (item.status !== 'completed') {
          item.status = 'completed';
          item.session = null;
          touchTodo(item);
          newlyCompleted.push(item);
        }
      }
      bundle.updatedAt = nowISO();
      await writeBundles(sc.todosPath, bundles);
      await writeChecklist(sc.todosPath, checklist);
      const summary = options.summary || `Bulk-completed via bundle b:${id}.`;
      for (const item of newlyCompleted) {
        const entry: LogEntry = {
          timestamp: nowISO(),
          itemIds: [item.id],
          items: item.description,
          session: null,
          branch: item.branch ?? bundle.branch ?? null,
          summary,
          blockers: null,
          status: null,
        };
        await appendLogEntry(sc.todosPath, sc.checklistKey, entry);
      }
      console.log(`Bundle b:${id} complete: ${newlyCompleted.length} newly completed, ${bundle.todoIds.length - newlyCompleted.length} already done`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
