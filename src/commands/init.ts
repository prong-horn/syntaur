import { resolve } from 'node:path';
import { syntaurRoot, defaultMissionDir } from '../utils/paths.js';
import { ensureDir, writeFileSafe, writeFileForce } from '../utils/fs.js';
import { renderConfig } from '../templates/config.js';

export interface InitOptions {
  force?: boolean;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const root = syntaurRoot();
  const missionsDir = defaultMissionDir();
  const configPath = resolve(root, 'config.md');

  await ensureDir(root);
  await ensureDir(missionsDir);

  const configContent = renderConfig({
    defaultMissionDir: missionsDir,
  });

  if (options.force) {
    await writeFileForce(configPath, configContent);
    console.log(`Created ${root}/`);
    console.log(`Created ${missionsDir}/`);
    console.log(`Wrote ${configPath} (overwritten)`);
  } else {
    const written = await writeFileSafe(configPath, configContent);
    console.log(`Created ${root}/`);
    console.log(`Created ${missionsDir}/`);
    if (written) {
      console.log(`Wrote ${configPath}`);
    } else {
      console.log(`Skipped ${configPath} (already exists; use --force to overwrite)`);
    }
  }

  console.log('\nSyntaur initialized successfully.');
}
