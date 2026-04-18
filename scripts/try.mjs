#!/usr/bin/env node
// Dev TUI: pick a syntaur worktree to link globally, or exit test mode.
// Standalone script (no build step) so it works regardless of which syntaur
// version is currently linked.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createElement as h, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';

const HOME = homedir();
function tilde(p) { return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p; }

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

function Menu({ items, linked, onChoose }) {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);

  const selectable = (i) => items[i] && items[i].kind !== 'divider';
  const nextSelectable = (start, dir) => {
    let i = start + dir;
    while (i >= 0 && i < items.length && !selectable(i)) i += dir;
    return selectable(i) ? i : start;
  };

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setIndex((i) => nextSelectable(i, -1));
    else if (key.downArrow || input === 'j') setIndex((i) => nextSelectable(i, 1));
    else if (key.return) {
      if (selectable(index)) {
        onChoose(items[index]);
        exit();
      }
    } else if (input === 'q' || key.escape) {
      onChoose(null);
      exit();
    }
  });

  const header = linked.path
    ? `syntaur → ${tilde(linked.path)}${linked.isLink ? ' (linked)' : ' (installed)'}`
    : 'syntaur → (none installed globally)';

  const maxBranch = Math.max(
    ...items.filter((i) => i.kind === 'link').map((i) => (i.branch ?? '').length),
    4,
  );

  const renderRow = (item, i) => {
    const selected = i === index;
    const cursor = selected ? '›' : ' ';
    const color = selected ? 'cyan' : undefined;

    if (item.kind === 'link') {
      return h(Box, { key: i },
        h(Text, { color }, `${cursor} `),
        h(Box, { width: maxBranch + 2 },
          h(Text, { color, bold: selected }, item.branch ?? '(detached)'),
        ),
        h(Text, { dimColor: true }, item.head ?? ''),
        item.isCurrent
          ? h(Text, { color: 'green' }, '  ← current')
          : null,
      );
    }
    if (item.kind === 'divider') {
      return h(Box, { key: i, marginTop: 1, marginBottom: 0 },
        h(Text, { dimColor: true }, '─── exit test mode ───'),
      );
    }
    return h(Box, { key: i },
      h(Text, { color }, `${cursor} ${item.label}`),
    );
  };

  return h(Box, { flexDirection: 'column', paddingX: 1, paddingY: 1 },
    h(Text, { bold: true }, 'syntaur try'),
    h(Box, { marginBottom: 1 }, h(Text, { dimColor: true }, header)),
    ...items.map(renderRow),
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: true }, '↑/↓ select · enter confirm · q quit'),
    ),
  );
}

async function main() {
  const worktrees = listWorktrees();
  const linked = currentlyLinkedPath();

  const items = [
    ...worktrees.map((w) => ({
      kind: 'link',
      path: w.path,
      branch: w.branch,
      head: w.head,
      isCurrent: linked.path === w.path,
    })),
    { kind: 'divider' },
    { kind: 'exit-restore', label: 'Restore published syntaur' },
    { kind: 'exit', label: 'Unlink only (no global syntaur after)' },
    { kind: 'quit', label: 'Cancel' },
  ];

  let chosen = null;
  const { waitUntilExit } = render(h(Menu, {
    items,
    linked,
    onChoose: (item) => { chosen = item; },
  }));
  await waitUntilExit();

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
