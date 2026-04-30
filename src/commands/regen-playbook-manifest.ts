import { playbooksDir as getPlaybooksDir } from '../utils/paths.js';
import { rebuildPlaybookManifest } from '../utils/playbooks.js';
import { fileExists } from '../utils/fs.js';

export async function regenPlaybookManifestCommand(): Promise<void> {
  const dir = getPlaybooksDir();
  if (!(await fileExists(dir))) {
    throw new Error(`Playbooks directory not found at ${dir}. Run "syntaur init" first.`);
  }
  await rebuildPlaybookManifest(dir);
  console.log(`Rebuilt playbook manifest at ${dir}/manifest.md`);
}
