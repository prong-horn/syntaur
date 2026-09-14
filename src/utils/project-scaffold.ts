import { basename, resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { ensureDir, fileExists, writeFileForce } from './fs.js';
import { nowTimestamp } from './timestamp.js';
import { generateId } from './uuid.js';
import { parseProject } from '../dashboard/parser.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import {
  renderManifest,
  renderProject,
  renderIndexTickets,
  renderIndexPlans,
  renderIndexDecisions,
  renderStatus,
} from '../templates/index.js';

export const REQUIRED_PROJECT_SCAFFOLD_FILES = [
  'project.md',
  'manifest.md',
  '_status.md',
  '_index-tickets.md',
  '_index-plans.md',
  '_index-decisions.md',
] as const;

export interface ProjectScaffoldParams {
  slug: string;
  title: string;
  prefix: string;
  nextTicket: number;
  id?: string;
  timestamp?: string;
}

const INDEX_STATUS_KEYS = [
  'pending',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
] as const;

function normalizeStatusForIndex(status: string): (typeof INDEX_STATUS_KEYS)[number] {
  if ((INDEX_STATUS_KEYS as readonly string[]).includes(status)) {
    return status as (typeof INDEX_STATUS_KEYS)[number];
  }
  return 'pending';
}

export async function writeProjectScaffold(
  projectDir: string,
  params: ProjectScaffoldParams,
  options?: { onlyMissing?: boolean },
): Promise<void> {
  const timestamp = params.timestamp ?? nowTimestamp();
  const id = params.id ?? generateId();

  await ensureDir(resolve(projectDir, 'tickets'));

  const files: Array<[string, string]> = [
    [resolve(projectDir, 'manifest.md'), renderManifest({ slug: params.slug, timestamp })],
    [
      resolve(projectDir, 'project.md'),
      renderProject({
        id,
        slug: params.slug,
        title: params.title,
        timestamp,
        prefix: params.prefix,
        nextTicket: params.nextTicket,
        defaultTemplate: 'feature',
      }),
    ],
    [
      resolve(projectDir, '_index-tickets.md'),
      renderIndexTickets({ slug: params.slug, title: params.title, timestamp }),
    ],
    [
      resolve(projectDir, '_index-plans.md'),
      renderIndexPlans({ slug: params.slug, title: params.title, timestamp }),
    ],
    [
      resolve(projectDir, '_index-decisions.md'),
      renderIndexDecisions({ slug: params.slug, title: params.title, timestamp }),
    ],
    [
      resolve(projectDir, '_status.md'),
      renderStatus({ slug: params.slug, title: params.title, timestamp }),
    ],
  ];

  for (const [filePath, content] of files) {
    if (options?.onlyMissing && (await fileExists(filePath))) continue;
    await writeFileForce(filePath, content);
  }
}

export async function rebuildProjectTicketIndex(projectDir: string): Promise<void> {
  const projectMdPath = resolve(projectDir, 'project.md');
  if (!(await fileExists(projectMdPath))) return;

  const projectMd = await readFile(projectMdPath, 'utf-8');
  const project = parseProject(projectMd);
  const slug = project.slug || basename(projectDir);
  const title = project.title || slug;
  const timestamp = nowTimestamp();

  const ticketsRoot = resolve(projectDir, 'tickets');
  const rows: Array<{
    slug: string;
    title: string;
    status: string;
    priority: string;
    assignee: string | null;
    depends_on: string[];
    updated: string;
    folderName: string;
  }> = [];

  if (await fileExists(ticketsRoot)) {
    const entries = await readdir(ticketsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) {
        continue;
      }
      const ticketMdPath = resolve(ticketsRoot, entry.name, 'ticket.md');
      if (!(await fileExists(ticketMdPath))) continue;
      const content = await readFile(ticketMdPath, 'utf-8');
      const fm = parseTicketFrontmatter(content);
      rows.push({
        slug: fm.slug,
        title: fm.title,
        status: fm.status,
        priority: fm.priority,
        assignee: fm.assignee,
        depends_on: fm.depends_on,
        updated: fm.updated,
        folderName: entry.name,
      });
    }
  }

  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  const byStatus: Record<(typeof INDEX_STATUS_KEYS)[number], number> = {
    pending: 0,
    in_progress: 0,
    blocked: 0,
    review: 0,
    completed: 0,
    failed: 0,
  };
  for (const row of rows) {
    byStatus[normalizeStatusForIndex(row.status)] += 1;
  }

  const tableRows = rows
    .map((row) => {
      const deps = row.depends_on.length > 0 ? row.depends_on.join(', ') : '—';
      const assignee = row.assignee ?? '—';
      const link = `[${row.slug}](./tickets/${row.folderName}/ticket.md)`;
      return `| ${link} | ${row.title} | ${row.status} | ${row.priority} | ${assignee} | ${deps} | ${row.updated} |`;
    })
    .join('\n');

  const indexContent = `---
project: ${slug}
generated: "${timestamp}"
total: ${rows.length}
by_status:
  pending: ${byStatus.pending}
  in_progress: ${byStatus.in_progress}
  blocked: ${byStatus.blocked}
  review: ${byStatus.review}
  completed: ${byStatus.completed}
  failed: ${byStatus.failed}
---

# Tickets

| Slug | Title | Status | Priority | Assignee | Dependencies | Updated |
|------|-------|--------|----------|----------|--------------|---------|
${tableRows}
`;

  await writeFileForce(resolve(projectDir, '_index-tickets.md'), indexContent);
  await writeFileForce(
    resolve(projectDir, 'manifest.md'),
    renderManifest({ slug, timestamp }),
  );
}
