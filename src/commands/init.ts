import { resolve, dirname } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { syntaurRoot, defaultMissionDir } from '../utils/paths.js';
import { ensureDir, writeFileSafe, writeFileForce, fileExists } from '../utils/fs.js';
import { renderConfig } from '../templates/config.js';
import { rebuildPlaybookManifest } from '../utils/playbooks.js';

export interface InitOptions {
  force?: boolean;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const root = syntaurRoot();
  const missionsDir = defaultMissionDir();
  const configPath = resolve(root, 'config.md');

  const playbooksDir = resolve(root, 'playbooks');

  await ensureDir(root);
  await ensureDir(missionsDir);
  await ensureDir(playbooksDir);

  const configContent = renderConfig({
    defaultMissionDir: missionsDir,
  });

  if (options.force) {
    await writeFileForce(configPath, configContent);
    console.log(`Created ${root}/`);
    console.log(`Created ${missionsDir}/`);
    console.log(`Created ${playbooksDir}/`);
    console.log(`Wrote ${configPath} (overwritten)`);
  } else {
    const written = await writeFileSafe(configPath, configContent);
    console.log(`Created ${root}/`);
    console.log(`Created ${missionsDir}/`);
    console.log(`Created ${playbooksDir}/`);
    if (written) {
      console.log(`Wrote ${configPath}`);
    } else {
      console.log(`Skipped ${configPath} (already exists; use --force to overwrite)`);
    }
  }

  // Seed default playbooks (only if they don't already exist)
  const seeded = await seedDefaultPlaybooks(playbooksDir);
  if (seeded > 0) {
    console.log(`Seeded ${seeded} default playbook(s) in ${playbooksDir}/`);
  }

  // Rebuild playbook index
  await rebuildPlaybookManifest(playbooksDir);

  console.log('\nSyntaur initialized successfully.');
}

async function seedDefaultPlaybooks(playbooksDir: string): Promise<number> {
  const __filename = fileURLToPath(import.meta.url);
  const packageRoot = resolve(dirname(__filename), '..');
  const examplesDir = resolve(packageRoot, 'examples', 'playbooks');

  if (!(await fileExists(examplesDir))) return 0;

  const entries = await readdir(examplesDir, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const targetPath = resolve(playbooksDir, entry.name);
    if (await fileExists(targetPath)) continue;

    const content = await readFile(resolve(examplesDir, entry.name), 'utf-8');
    await writeFileSafe(targetPath, content);
    count++;
  }

  return count;
}
