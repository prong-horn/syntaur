#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

function gitMv(from, to) {
  const a = join(ROOT, from);
  const b = join(ROOT, to);
  try {
    execSync(`git mv "${a}" "${b}"`, { cwd: ROOT, stdio: 'pipe' });
    console.log('git mv', from, '->', to);
  } catch (e) {
    console.warn('skip mv', from, e.message?.split('\n')[0]);
  }
}

const SKILL_RENAMES = [
  ['skills/grab-ticket', 'skills/grab-ticket'],
  ['skills/clear-ticket', 'skills/clear-ticket'],
  ['skills/create-ticket', 'skills/create-ticket'],
  ['skills/plan-ticket', 'skills/plan-ticket'],
  ['skills/complete-ticket', 'skills/complete-ticket'],
  ['skills/list-tickets', 'skills/list-tickets'],
];

const CMD_RENAMES = [
  ['platforms/claude-code/commands/grab-ticket', 'platforms/claude-code/commands/grab-ticket'],
  ['platforms/claude-code/commands/clear-ticket', 'platforms/claude-code/commands/clear-ticket'],
  ['platforms/claude-code/commands/create-ticket', 'platforms/claude-code/commands/create-ticket'],
  ['platforms/claude-code/commands/plan-ticket', 'platforms/claude-code/commands/plan-ticket'],
  ['platforms/claude-code/commands/complete-ticket', 'platforms/claude-code/commands/complete-ticket'],
  ['platforms/claude-code/commands/list-tickets', 'platforms/claude-code/commands/list-tickets'],
];

for (const [from, to] of [...SKILL_RENAMES, ...CMD_RENAMES]) {
  gitMv(from, to);
}

gitMv('docs/ticket-chat.md', 'docs/ticket-chat.md');
gitMv('examples/sample-project/tickets', 'examples/sample-project/tickets');
gitMv('examples/sample-project/_index-tickets.md', 'examples/sample-project/_index-tickets.md');
gitMv('examples/playbooks/ticket-planning.md', 'examples/playbooks/ticket-planning.md');
gitMv('examples/playbooks/ticket-creation.md', 'examples/playbooks/ticket-creation.md');

const codexCmds = [
  ['platforms/codex/commands/list-tickets.md', 'platforms/codex/commands/list-tickets.md'],
  ['platforms/codex/commands/grab-ticket.md', 'platforms/codex/commands/grab-ticket.md'],
  ['platforms/codex/commands/clear-ticket.md', 'platforms/codex/commands/clear-ticket.md'],
  ['platforms/codex/commands/create-ticket.md', 'platforms/codex/commands/create-ticket.md'],
  ['platforms/codex/commands/plan-ticket.md', 'platforms/codex/commands/plan-ticket.md'],
  ['platforms/codex/commands/complete-ticket.md', 'platforms/codex/commands/complete-ticket.md'],
];
for (const [from, to] of codexCmds) {
  gitMv(from, to);
}

// Rename inner command md files for claude-code
for (const [, to] of CMD_RENAMES) {
  const base = to.split('/').pop();
  const innerFrom = join(ROOT, to, `${base.replace('-ticket', '-ticket').replace('list-tickets', 'list-tickets')}.md`);
  const innerTo = join(ROOT, to, `${base}.md`);
  // After git mv, inner file still has old name
  const oldNames = {
    'grab-ticket': 'grab-ticket',
    'clear-ticket': 'clear-ticket',
    'create-ticket': 'create-ticket',
    'plan-ticket': 'plan-ticket',
    'complete-ticket': 'complete-ticket',
    'list-tickets': 'list-tickets',
  };
  const old = oldNames[base];
  if (old) {
    const a = join(ROOT, to, `${old}.md`);
    const b = join(ROOT, to, `${base}.md`);
    try { renameSync(a, b); console.log('rename inner', relative(ROOT, a), '->', relative(ROOT, b)); } catch {}
  }
}

// Rename ticket.md → ticket.md in examples
const ticketsDir = join(ROOT, 'examples/sample-project/tickets');
for (const name of readdirSync(ticketsDir)) {
  const p = join(ticketsDir, name, 'ticket.md');
  try { renameSync(p, join(ticketsDir, name, 'ticket.md')); console.log('rename', name, '/ticket.md -> ticket.md'); } catch {}
}

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'fixtures', 'releases', 'superpowers', 'claude-info',
]);
const SKIP_FILES = /migrate-.*\.ts$|ticket-resolver\.ts$|ticket-target\.ts$|ticket-walk\.ts$/;

const ROOTS = [
  'skills', 'platforms', 'docs', 'examples', 'README.md', 'AGENTS.md', 'statusline',
  'scripts', 'references', 'src/templates', 'src/utils/install-skills.ts',
  'src/dashboard/help.ts', 'src/dashboard/overviewCopy.ts', '.claude-plugin',
  'src/__tests__/hotkeys-config.test.ts', 'src/__tests__/hotkeys-catalog.test.ts',
  'src/__tests__/search-schema.test.ts', 'src/__tests__/search-config.test.ts',
  'src/__tests__/install-skills.test.ts', 'src/__tests__/adapter-templates.test.ts',
];

function walk(entry, files = []) {
  const p = join(ROOT, entry);
  try {
    const st = statSync(p);
    if (st.isFile()) {
      if (/\.(md|ts|tsx|json|sh|py|yaml|mjs|template|mdc)$/.test(entry) && !SKIP_FILES.test(entry)) {
        files.push(p);
      }
      return files;
    }
  } catch { return files; }
  if (statSync(p).isDirectory()) {
    if (SKIP_DIRS.has(entry.split('/').pop() ?? entry)) return files;
    for (const name of readdirSync(p)) {
      if (SKIP_DIRS.has(name)) continue;
      walk(join(entry, name), files);
    }
  }
  return files;
}

const files = new Set();
for (const r of ROOTS) {
  for (const f of walk(r)) files.add(f);
}

const REPS = [
  ['grab-ticket', 'grab-ticket'],
  ['clear-ticket', 'clear-ticket'],
  ['create-ticket', 'create-ticket'],
  ['plan-ticket', 'plan-ticket'],
  ['complete-ticket', 'complete-ticket'],
  ['list-tickets', 'list-tickets'],
  ['syntaur new', 'syntaur new'],
  ['syntaur new', 'syntaur new'],
  ['/_index-tickets.md', '/_index-tickets.md'],
  ['_index-tickets.md', '_index-tickets.md'],
  ['ticket.md', 'ticket.md'],
  ['tickets/', 'tickets/'],
  ['/tickets', '/tickets'],
  ['ticket-chat.md', 'ticket-chat.md'],
  ['ticket-chat', 'ticket-chat'],
  ['new-ticket', 'new-ticket'],
  ["'g t'", "'g t'"],
  ['g t', 'g t'],
  ['Tickets', 'Tickets'],
  ['Ticket', 'Ticket'],
  ['tickets', 'tickets'],
  ['ticket', 'ticket'],
];

for (const f of files) {
  let c = readFileSync(f, 'utf8');
  const orig = c;
  for (const [a, b] of REPS) c = c.split(a).join(b);
  // restore SQL / db column names
  c = c.replace(/\bticket_id\b/g, 'assignment_id');
  c = c.replace(/\bticket_slug\b/g, 'assignment_slug');
  if (c !== orig) writeFileSync(f, c);
}

// Fix skill frontmatter name: fields
for (const [, to] of SKILL_RENAMES) {
  const skill = join(ROOT, to, 'SKILL.md');
  try {
    let c = readFileSync(skill, 'utf8');
    const name = to.split('/').pop();
    c = c.replace(/^name: .+$/m, `name: ${name}`);
    writeFileSync(skill, c);
  } catch {}
}

console.log('task4-docs done');
