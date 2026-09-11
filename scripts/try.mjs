#!/usr/bin/env node
// Dev helper: pick a syntaur worktree to link globally, or exit test mode.
// Standalone script (no build step) so it works regardless of which syntaur
// version is currently linked.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { select, Separator } from '@inquirer/prompts';

const HOME = homedir();
function tilde(p) {
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);

function sh(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function listWorktrees() {
  const out = sh('git worktree list --porcelain');
  const entries = [];
  let current = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).slice(0, 7);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      current.branch = '(detached)';
    }
  }
  if (current.path) entries.push(current);
  return entries;
}

function currentlyLinkedPath() {
  try {
    const globalRoot = sh('npm root -g');
    const linkPath = join(globalRoot, 'syntaur');
    if (!existsSync(linkPath)) return { path: null, isLink: false };
    let isLink = false;
    try {
      readlinkSync(linkPath);
      isLink = true;
    } catch {}
    return { path: realpathSync(linkPath), isLink };
  } catch {
    return { path: null, isLink: false };
  }
}

function runStreaming(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${res.status})`);
}

function linkWorktree(worktreePath) {
  if (!existsSync(join(worktreePath, 'node_modules'))) {
    console.log(`\n→ installing deps in ${worktreePath} (first time)`);
    runStreaming('npm', ['install'], worktreePath);
  }
  console.log(`\n→ rebuilding native modules for current Node version`);
  runStreaming('npm', ['rebuild', 'better-sqlite3'], worktreePath);
  console.log(`\n→ building CLI + dashboard in ${worktreePath}`);
  runStreaming('npm', ['run', 'build:dashboard'], worktreePath);
  console.log(`\n→ linking syntaur globally from ${worktreePath}`);
  runStreaming('npm', ['link'], worktreePath);
}

function startDashboard() {
  console.log('\n→ starting dashboard (Ctrl+C to stop)\n');
  const res = spawnSync('syntaur', ['dashboard'], { stdio: 'inherit' });
  if (res.error) throw res.error;
  process.exit(res.status ?? 0);
}

function exitTestMode({ restore }) {
  console.log('\n→ unlinking local syntaur');
  spawnSync('npm', ['unlink', '-g', 'syntaur'], { stdio: 'inherit' });
  if (restore) {
    console.log('\n→ reinstalling published syntaur globally');
    runStreaming('npm', ['install', '-g', 'syntaur@latest'], process.cwd());
  }
}

function formatWorktreeLabel(w, maxBranch, isCurrent) {
  const branch = (w.branch ?? '(detached)').padEnd(maxBranch + 2);
  const current = isCurrent ? '  ← current' : '';
  return `${branch}${w.head ?? ''}${current}`;
}

function printHelp() {
  console.log(`syntaur try — link a local worktree globally for testing

Usage:
  node scripts/try.mjs
  npm run try

Interactive menu:
  • Pick a git worktree to npm link and start the dashboard
  • Restore published syntaur (unlink + npm install -g syntaur@latest)
  • Unlink only (no global syntaur after)
  • Cancel`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const worktrees = listWorktrees();
  const linked = currentlyLinkedPath();

  const header = linked.path
    ? `syntaur → ${tilde(linked.path)}${linked.isLink ? ' (linked)' : ' (installed)'}`
    : 'syntaur → (none installed globally)';

  console.log('\nsyntaur try');
  console.log(header);

  const maxBranch = Math.max(...worktrees.map((w) => (w.branch ?? '').length), 4);

  const choices = [
    ...worktrees.map((w) => ({
      name: formatWorktreeLabel(w, maxBranch, linked.path === w.path),
      value: { kind: 'link', path: w.path },
    })),
    new Separator('─── exit test mode ───'),
    { name: 'Restore published syntaur', value: { kind: 'exit-restore' } },
    { name: 'Unlink only (no global syntaur after)', value: { kind: 'exit' } },
    { name: 'Cancel', value: { kind: 'quit' } },
  ];

  let chosen;
  try {
    chosen = await select({
      message: 'Select worktree or action',
      choices,
    });
  } catch (err) {
    if (err?.name === 'ExitPromptError') {
      console.log('\nno changes');
      return;
    }
    throw err;
  }

  if (!chosen || chosen.kind === 'quit') {
    console.log('\nno changes');
    return;
  }
  if (chosen.kind === 'link') {
    linkWorktree(chosen.path);
    console.log(`\n✓ syntaur now runs from ${chosen.path}`);
    console.log('  To exit test mode later: syntaur-try untry');
    startDashboard();
    return;
  }
  if (chosen.kind === 'exit-restore') {
    exitTestMode({ restore: true });
    console.log('\n✓ global syntaur is now the npm-published version');
    return;
  }
  if (chosen.kind === 'exit') {
    exitTestMode({ restore: false });
    console.log('\n✓ local link removed; no global syntaur installed');
    console.log('  (use `npx syntaur@latest <cmd>` for the published version)');
    return;
  }
}

main().catch((err) => {
  console.error('\nerror:', err.message);
  process.exit(1);
});
