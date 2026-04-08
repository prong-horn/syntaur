import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { playbooksDir as getPlaybooksDir } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';
import { parsePlaybook } from '../dashboard/parser.js';

export async function listPlaybooksCommand(): Promise<void> {
  const dir = getPlaybooksDir();

  if (!(await fileExists(dir))) {
    console.log('No playbooks directory found. Run "syntaur init" first.');
    return;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_') && e.name !== 'manifest.md');

  if (mdFiles.length === 0) {
    console.log('No playbooks found. Create one with "syntaur create-playbook <name>".');
    return;
  }

  console.log(`Found ${mdFiles.length} playbook(s):\n`);
  console.log(`${'Slug'.padEnd(30)} ${'Name'.padEnd(30)} Description`);
  console.log(`${'─'.repeat(30)} ${'─'.repeat(30)} ${'─'.repeat(40)}`);

  for (const entry of mdFiles) {
    const filePath = resolve(dir, entry.name);
    const raw = await readFile(filePath, 'utf-8');
    const parsed = parsePlaybook(raw);

    const slug = parsed.slug || entry.name.replace(/\.md$/, '');
    const name = parsed.name || slug;
    const desc = parsed.description || '';

    console.log(`${slug.padEnd(30)} ${name.padEnd(30)} ${desc}`);
  }
}
