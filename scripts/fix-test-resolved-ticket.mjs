#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'fixtures') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (name.endsWith('.test.ts')) files.push(p);
  }
  return files;
}

function addCompatFields(c) {
  return c.replace(
    /ticketDir:\s*([^,\n}]+),\s*\n(\s*)projectSlug:\s*([^,\n}]+),\s*\n\s*ticketSlug:\s*([^,\n}]+),\s*\n\s*id:\s*([^,\n}]+),\s*\n\s*standalone:\s*(true|false)/g,
    (m, dir, indent, project, slug, id, standalone) => {
      if (m.includes('assignmentDir:')) return m;
      return `ticketDir: ${dir},
${indent}projectSlug: ${project},
${indent}ticketSlug: ${slug},
${indent}id: ${id},
${indent}standalone: ${standalone},
${indent}assignmentDir: ${dir},
${indent}assignmentSlug: ${slug},
${indent}assignmentId: ${id}`;
    },
  );
}

for (const f of walk(join(ROOT, 'src', '__tests__'))) {
  let c = readFileSync(f, 'utf8');
  const orig = c;
  c = addCompatFields(c);
  // chat-broker tests: helper param often named ticket but body still says assignment
  if (f.includes('chat-broker')) {
    c = c.replace(/\bawait broker\.(send|withdraw|cancel|getParticipants|setParticipants|reindex|items)\(\{\s*assignment,/g, (m) =>
      m.replace('assignment,', 'ticket,'),
    );
    c = c.replace(/\bbroker\.(send|withdraw|cancel|getParticipants|setParticipants|reindex|items)\(assignment/g, (m, _a, method) =>
      `broker.${method}(ticket`,
    );
    c = c.replace(/\bensureSession\(assignment/g, 'ensureSession(ticket');
    c = c.replace(/\bawait ensureTicketSessions\(assignment\)/g, 'await ensureTicketSessions(ticket)');
    c = c.replace(/const assignment =/g, 'const ticket =');
    c = c.replace(/function assignment\(/g, 'function ticket(');
  }
  if (c !== orig) {
    writeFileSync(f, c);
    console.log('fixed', relative(ROOT, f));
  }
}
