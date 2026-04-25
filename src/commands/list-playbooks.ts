import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { playbooksDir as getPlaybooksDir } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { parsePlaybook } from '../dashboard/parser.js';
import { readConfig } from '../utils/config.js';

export interface ListPlaybooksOptions {
  all?: boolean;
}

export async function listPlaybooksCommand(
  options: ListPlaybooksOptions = {},
): Promise<void> {
  const dir = getPlaybooksDir();

  if (!(await fileExists(dir))) {
    console.log('No playbooks directory found. Run "syntaur init" first.');
    return;
  }

  const config = await readConfig();
  const disabledSet = new Set(config.playbooks.disabled);

  const entries = await readdir(dir, { withFileTypes: true });
  const mdFiles = entries.filter(
    (e) =>
      e.isFile() &&
      e.name.endsWith('.md') &&
      !e.name.startsWith('_') &&
      e.name !== 'manifest.md',
  );

  interface Row {
    slug: string;
    name: string;
    desc: string;
    disabled: boolean;
  }

  const rows: Row[] = [];
  for (const entry of mdFiles) {
    const filePath = resolve(dir, entry.name);
    const raw = await readFile(filePath, 'utf-8');
    const parsed = parsePlaybook(raw);
    const slug = parsed.slug || entry.name.replace(/\.md$/, '');
    const disabled = disabledSet.has(slug);

    if (disabled && !options.all) continue;

    rows.push({
      slug,
      name: parsed.name || slug,
      desc: parsed.description || '',
      disabled,
    });
  }

  if (rows.length === 0) {
    if (!options.all && disabledSet.size > 0) {
      console.log(
        `No enabled playbooks found (${disabledSet.size} disabled). Use --all to include disabled playbooks.`,
      );
    } else {
      console.log('No playbooks found. Create one with "syntaur create-playbook <name>".');
    }
    return;
  }

  const totalLabel = options.all
    ? `Found ${rows.length} playbook(s) (${[...disabledSet].length} disabled):`
    : `Found ${rows.length} enabled playbook(s):`;
  console.log(`${totalLabel}\n`);
  console.log(`${'Slug'.padEnd(30)} ${'Name'.padEnd(30)} Description`);
  console.log(`${'─'.repeat(30)} ${'─'.repeat(30)} ${'─'.repeat(40)}`);

  for (const row of rows) {
    const suffix = row.disabled ? ' (disabled)' : '';
    const desc = `${row.desc}${suffix}`;
    console.log(`${row.slug.padEnd(30)} ${row.name.padEnd(30)} ${desc}`);
  }
}
