import { runProjectRestore, type ArchiveOptions } from './archive.js';

export async function restoreCommand(target: string, options: ArchiveOptions): Promise<void> {
  await runProjectRestore(target, options);
}
