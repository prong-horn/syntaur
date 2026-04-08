import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from './fs.js';
import { parsePlaybook } from '../dashboard/parser.js';
import { nowTimestamp } from './timestamp.js';

export async function rebuildPlaybookManifest(playbooksDir: string): Promise<void> {
  if (!(await fileExists(playbooksDir))) return;

  const entries = await readdir(playbooksDir, { withFileTypes: true });
  const rows: Array<{ name: string; slug: string; description: string; whenToUse: string }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('_') || entry.name === 'manifest.md') continue;

    const raw = await readFile(resolve(playbooksDir, entry.name), 'utf-8');
    const parsed = parsePlaybook(raw);
    const slug = parsed.slug || entry.name.replace(/\.md$/, '');

    rows.push({
      name: parsed.name || slug,
      slug,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  const timestamp = nowTimestamp();
  const lines = [
    '---',
    `generated: "${timestamp}"`,
    `total: ${rows.length}`,
    '---',
    '',
    '# Playbooks',
    '',
    'Behavioral rules for AI agents. Read and follow all playbooks before starting work.',
    '',
  ];

  for (const row of rows) {
    lines.push(`- **[${row.name}](${row.slug}.md)** — ${row.description}`);
    if (row.whenToUse) {
      lines.push(`  _When to use: ${row.whenToUse}_`);
    }
  }

  lines.push('');

  await writeFileForce(resolve(playbooksDir, 'manifest.md'), lines.join('\n'));
}
